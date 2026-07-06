//! Remote-asset localization for the Reflect V1 import.
//!
//! V1 notes link attachments straight at Firebase Storage download URLs. An
//! import must not leave a graph depending on Reflect V1's infrastructure, so
//! every such URL is downloaded into the graph's `assets/` directory and the
//! markdown link is rewritten to the relative `assets/…` path.
//!
//! Download failures split by permanence: a 4xx means the asset is gone (or
//! the token was revoked) and no retry will help, so the note keeps its remote
//! link and the failure is counted; a network-level failure or 5xx is
//! transient, so the whole import aborts *before any graph write* and the user
//! can simply retry.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::error::{AppError, AppResult};

/// Only asset links on Reflect V1's storage host are localized; every other
/// URL in the export is an ordinary link and imports untouched.
pub(super) const V1_ASSET_URL_PREFIX: &str = "https://firebasestorage.googleapis.com/";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Per-read stall timeout. There is deliberately no whole-request timeout so
/// a large video on a slow connection still finishes.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const CONCURRENT_DOWNLOADS: usize = 6;
/// Collision probes before giving up, mirroring `persist_unique`'s cap.
const MAX_NAME_PROBES: u32 = 1000;

/// One remote-asset URL occurrence inside a markdown file.
pub(super) struct RemoteSpan {
    /// Byte offset of the first URL character in the markdown.
    pub start: usize,
    /// Byte offset one past the last URL character.
    pub end: usize,
    /// The URL with markdown escapes removed (`\&` → `&`), ready to fetch.
    pub url: String,
}

/// What a download attempt produced for one URL.
pub(super) enum DownloadOutcome {
    /// Bytes staged in `.reflect/tmp`, waiting for the import to persist them.
    Fetched(FetchedAsset),
    /// The remote answered a permanent 4xx; the note keeps the remote link.
    Gone,
}

/// A successfully downloaded attachment, staged and waiting to be persisted.
pub(super) struct FetchedAsset {
    /// Temp file in `.reflect/tmp` holding the downloaded bytes; deletes on
    /// drop if the import aborts before persisting it.
    pub file: tempfile::NamedTempFile,
    /// Sanitized filename the asset would like under `assets/` (collision
    /// suffixes are decided later, against the live graph).
    pub desired_name: String,
}

/// Find every remote-asset URL in `markdown` that starts with `prefix`.
///
/// V1 exports escape URL punctuation the CommonMark way (`?alt=media\&token=`),
/// so the span keeps the escaped bytes (for splicing) while `url` holds the
/// unescaped form (for fetching). A span ends at whitespace or any character
/// that terminates a markdown link destination.
pub(super) fn scan_remote_spans(markdown: &str, prefix: &str) -> Vec<RemoteSpan> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(found) = markdown[from..].find(prefix) {
        let start = from + found;
        let mut url = String::new();
        let mut cursor = start;
        let mut chars = markdown[start..].char_indices().peekable();
        while let Some((offset, ch)) = chars.next() {
            cursor = start + offset;
            if ch == '\\' {
                match chars.peek() {
                    Some(&(_, next)) if next.is_ascii_punctuation() => {
                        url.push(next);
                        let (next_offset, _) = chars.next().expect("peeked");
                        cursor = start + next_offset + next.len_utf8() - 1;
                        continue;
                    }
                    // A lone trailing backslash is markdown's hard line
                    // break, not part of the URL.
                    _ => {
                        cursor -= 1;
                        break;
                    }
                }
            }
            if ch.is_whitespace() || matches!(ch, ')' | ']' | '<' | '>' | '"' | '\'' | '`') {
                cursor -= 1;
                break;
            }
            url.push(ch);
            cursor = start + offset + ch.len_utf8() - 1;
        }
        let end = cursor + 1;
        if url.len() > prefix.len() {
            spans.push(RemoteSpan { start, end, url });
        }
        from = end.max(start + 1);
    }
    spans
}

/// Replace the remote spans of `markdown` whose URL has a localized path in
/// `replacements` (URL → `assets/…`). URLs without a replacement (permanent
/// download failures) keep their remote form.
pub(super) fn rewrite_markdown(
    markdown: &str,
    prefix: &str,
    replacements: &HashMap<String, String>,
) -> String {
    let mut result = markdown.to_string();
    for span in scan_remote_spans(markdown, prefix).into_iter().rev() {
        if let Some(local) = replacements.get(&span.url) {
            result.replace_range(span.start..span.end, local);
        }
    }
    result
}

/// Download every URL into `staging`, a few at a time. Returns the outcome
/// per URL, or the first transient error — in which case nothing survives
/// (the staged temp files delete on drop) and the import can be retried.
pub(super) async fn download_remote_assets(
    staging: &Path,
    urls: Vec<String>,
) -> AppResult<HashMap<String, DownloadOutcome>> {
    if urls.is_empty() {
        return Ok(HashMap::new());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .user_agent(concat!("Reflect/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| AppError::io(err.to_string()))?;

    let queue = Arc::new(Mutex::new(urls));
    let results = Arc::new(Mutex::new(Ok(HashMap::new())));
    let workers = CONCURRENT_DOWNLOADS.min(lock(&queue)?.len());
    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let queue = Arc::clone(&queue);
        let results = Arc::clone(&results);
        let client = client.clone();
        let staging = staging.to_path_buf();
        handles.push(tauri::async_runtime::spawn(async move {
            loop {
                let Some(url) = next_url(&queue, &results) else {
                    return;
                };
                let outcome = fetch_asset(&client, &url, &staging).await;
                let Ok(mut results) = results.lock() else {
                    return;
                };
                match outcome {
                    Ok(outcome) => {
                        if let Ok(map) = results.as_mut() {
                            map.insert(url, outcome);
                        }
                    }
                    Err(err) => *results = Err(err),
                }
            }
        }));
    }
    for handle in handles {
        handle
            .await
            .map_err(|err| AppError::io(format!("asset download task failed: {err}")))?;
    }
    Arc::into_inner(results)
        .and_then(|mutex| mutex.into_inner().ok())
        .ok_or_else(|| AppError::io("asset download state lock poisoned"))?
}

fn lock<T>(mutex: &Arc<Mutex<T>>) -> AppResult<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| AppError::io("asset download state lock poisoned"))
}

/// Pop the next URL, or `None` once the queue is drained *or* another worker
/// already recorded an error — no point downloading into an aborted import.
fn next_url(
    queue: &Arc<Mutex<Vec<String>>>,
    results: &Arc<Mutex<AppResult<HashMap<String, DownloadOutcome>>>>,
) -> Option<String> {
    if results.lock().ok()?.is_err() {
        return None;
    }
    queue.lock().ok()?.pop()
}

fn classify_fetch_error(err: reqwest::Error) -> AppError {
    if err.is_timeout() || err.is_connect() || err.is_request() {
        AppError::Network {
            message: err.to_string(),
        }
    } else {
        AppError::io(err.to_string())
    }
}

async fn fetch_asset(
    client: &reqwest::Client,
    url: &str,
    staging: &Path,
) -> AppResult<DownloadOutcome> {
    let response = client.get(url).send().await.map_err(classify_fetch_error)?;
    let status = response.status();
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(AppError::Network {
            message: format!("asset download answered {status}: {url}"),
        });
    }
    if !status.is_success() {
        tracing::warn!(%url, %status, "V1 asset is gone; keeping the remote link");
        return Ok(DownloadOutcome::Gone);
    }

    let desired_name = sanitize_asset_file_name(&original_name(&response, url));
    let mut file = tempfile::NamedTempFile::new_in(staging)?;
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(classify_fetch_error)? {
        file.as_file_mut().write_all(&chunk)?;
    }
    file.as_file().sync_all()?;
    Ok(DownloadOutcome::Fetched(FetchedAsset {
        file,
        desired_name,
    }))
}

/// The best original filename available: the `Content-Disposition` filename
/// Firebase Storage serves (the name the attachment was uploaded with), else
/// the object id from the URL path. Either way, a name without an extension
/// gets one inferred from the response's `Content-Type` — V1 stored many
/// attachments under their bare content id.
fn original_name(response: &reqwest::Response, url: &str) -> String {
    let name = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(content_disposition_filename)
        .or_else(|| url_object_id(url))
        .unwrap_or_else(|| "asset".to_string());
    if has_extension(&name) {
        return name;
    }
    let extension = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(extension_for_content_type);
    match extension {
        Some(extension) => format!("{name}.{extension}"),
        None => name,
    }
}

fn has_extension(name: &str) -> bool {
    matches!(name.rfind('.'), Some(index) if index > 0 && index < name.len() - 1)
}

/// Parse the filename out of a `Content-Disposition` header, preferring the
/// RFC 5987 `filename*` form over the plain `filename` fallback.
fn content_disposition_filename(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';') {
        let part = part.trim();
        let lower = part.to_ascii_lowercase();
        if let Some(rest) = lower
            .strip_prefix("filename*=")
            .map(|_| &part["filename*=".len()..])
        {
            let encoded = rest.split_once("''").map_or(rest, |(_, encoded)| encoded);
            let decoded = percent_decode(encoded.trim_matches('"'));
            if !decoded.is_empty() {
                return Some(decoded);
            }
        } else if let Some(rest) = lower
            .strip_prefix("filename=")
            .map(|_| &part["filename=".len()..])
        {
            let name = rest.trim_matches('"').to_string();
            if !name.is_empty() {
                plain = Some(name);
            }
        }
    }
    plain
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The last path segment of the storage object, percent-decoded: Firebase
/// URLs encode the object path as one segment (`users%2F<uid>%2F<id>`), so
/// decoding first yields the trailing content id.
fn url_object_id(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let decoded = percent_decode(path);
    let segment = decoded.rsplit('/').next()?.trim();
    if segment.is_empty() {
        return None;
    }
    Some(segment.to_string())
}

fn extension_for_content_type(content_type: &str) -> Option<&'static str> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/heic" => Some("heic"),
        "video/mp4" => Some("mp4"),
        "video/quicktime" => Some("mov"),
        "video/webm" => Some("webm"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/mpeg" => Some("mp3"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "application/pdf" => Some("pdf"),
        "text/plain" => Some("txt"),
        "application/json" => Some("json"),
        "application/zip" => Some("zip"),
        _ => None,
    }
}

/// Windows reserved device names (case-insensitive, extension-less); mirrors
/// the frozen list in `packages/core/src/markdown/slug.ts`.
fn is_windows_reserved(stem: &str) -> bool {
    matches!(
        stem,
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

const MAX_STEM_CHARS: usize = 60;
const MAX_EXTENSION_CHARS: usize = 12;

/// Rust mirror of `assetFileName` in `packages/core/src/graph/asset-names.ts`
/// (minus NFC normalization, which needs no dependency for the ASCII names
/// Firebase serves): slugged lowercase stem, inner dots to dashes, extension
/// kept but reduced to short lowercase alphanumerics.
pub(super) fn sanitize_asset_file_name(original: &str) -> String {
    let trimmed = original.trim();
    let (stem, extension) = match trimmed.rfind('.') {
        Some(index) if index > 0 && index < trimmed.len() - 1 => (
            &trimmed[..index],
            trimmed[index + 1..]
                .to_lowercase()
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .take(MAX_EXTENSION_CHARS)
                .collect::<String>(),
        ),
        _ => (trimmed, String::new()),
    };

    let mut slug = String::new();
    let mut pending_separator = false;
    for ch in stem.replace('.', "-").to_lowercase().chars() {
        if ch.is_alphanumeric() {
            if pending_separator && !slug.is_empty() {
                slug.push('-');
            }
            pending_separator = false;
            slug.push(ch);
        } else if ch.is_whitespace() || ch == '-' || ch == '_' {
            pending_separator = true;
        }
    }
    let mut slug: String = slug.chars().take(MAX_STEM_CHARS).collect();
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug = "untitled".to_string();
    }
    if is_windows_reserved(&slug) {
        slug.push_str("-note");
    }
    if extension.is_empty() {
        slug
    } else {
        format!("{slug}.{extension}")
    }
}

/// Decide the on-disk name a fetched asset will persist under, *without*
/// claiming it: probing here (instead of `persist_unique`) lets the import
/// rewrite markdown and run its collision checks before any graph write.
/// A candidate already holding identical bytes is reused instead of written —
/// re-importing the same export must not duplicate every attachment.
pub(super) struct PlannedAssetName {
    pub name: String,
    /// True when `assets/<name>` already holds these exact bytes.
    pub reuse: bool,
}

pub(super) fn plan_asset_name(
    assets_dir: &Path,
    desired: &str,
    staged: &Path,
    taken: &std::collections::HashSet<String>,
) -> AppResult<PlannedAssetName> {
    let (stem, extension) = match desired.rfind('.') {
        Some(index) if index > 0 => desired.split_at(index),
        _ => (desired, ""),
    };
    for attempt in 1..=MAX_NAME_PROBES {
        let candidate = if attempt == 1 {
            desired.to_string()
        } else {
            format!("{stem}-{attempt}{extension}")
        };
        if taken.contains(&candidate) {
            continue;
        }
        let target = assets_dir.join(&candidate);
        if !target.exists() && !super::io::file_occupied(&target) {
            return Ok(PlannedAssetName {
                name: candidate,
                reuse: false,
            });
        }
        if target.is_file() && same_file_bytes(&target, staged)? {
            return Ok(PlannedAssetName {
                name: candidate,
                reuse: true,
            });
        }
    }
    Err(AppError::io(format!(
        "no free asset name after {MAX_NAME_PROBES} probes for {desired}"
    )))
}

/// Whether two files hold identical bytes: length check first, then a
/// fixed-size chunked comparison — attachments can be videos, so neither file
/// is ever read into memory whole.
pub(super) fn same_file_bytes(existing: &Path, staged: &Path) -> AppResult<bool> {
    let existing_meta = std::fs::metadata(existing)?;
    let staged_meta = std::fs::metadata(staged)?;
    if existing_meta.len() != staged_meta.len() {
        return Ok(false);
    }
    let mut left = std::io::BufReader::new(std::fs::File::open(existing)?);
    let mut right = std::io::BufReader::new(std::fs::File::open(staged)?);
    let mut left_chunk = [0u8; 64 * 1024];
    let mut right_chunk = [0u8; 64 * 1024];
    loop {
        let read = left.read(&mut left_chunk)?;
        if read == 0 {
            return Ok(true);
        }
        right.read_exact(&mut right_chunk[..read])?;
        if left_chunk[..read] != right_chunk[..read] {
            return Ok(false);
        }
    }
}

/// Persist a staged download at its planned name. The plan already verified
/// the name was free; `persist_noclobber` keeps a concurrent claim from
/// silently clobbering — losing that race is a loud error, not a rename.
pub(super) fn persist_planned(
    fetched: FetchedAsset,
    assets_dir: &Path,
    name: &str,
) -> AppResult<()> {
    std::fs::create_dir_all(assets_dir)?;
    fetched
        .file
        .persist_noclobber(assets_dir.join(name))
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use tempfile::tempdir;

    const PREFIX: &str = "https://firebasestorage.googleapis.com/";

    #[test]
    fn scan_finds_escaped_urls_in_link_destinations() {
        let markdown = "![](https://firebasestorage.googleapis.com/v0/b/x/o/a?alt=media\\&token=t)\nplain text\n[memo.m4a](https://firebasestorage.googleapis.com/v0/b/x/o/b?alt=media\\&token=u)";
        let spans = scan_remote_spans(markdown, PREFIX);
        assert_eq!(spans.len(), 2);
        assert_eq!(
            spans[0].url,
            "https://firebasestorage.googleapis.com/v0/b/x/o/a?alt=media&token=t"
        );
        assert_eq!(
            &markdown[spans[0].start..spans[0].end],
            "https://firebasestorage.googleapis.com/v0/b/x/o/a?alt=media\\&token=t"
        );
        assert_eq!(
            spans[1].url,
            "https://firebasestorage.googleapis.com/v0/b/x/o/b?alt=media&token=u"
        );
    }

    #[test]
    fn scan_ignores_other_hosts() {
        let markdown = "[a](https://example.com/file.png)";
        assert!(scan_remote_spans(markdown, PREFIX).is_empty());
    }

    #[test]
    fn scan_stops_at_terminators() {
        let markdown = "see https://firebasestorage.googleapis.com/v0/o/a?alt=media end";
        let spans = scan_remote_spans(markdown, PREFIX);
        assert_eq!(spans.len(), 1);
        assert_eq!(
            spans[0].url,
            "https://firebasestorage.googleapis.com/v0/o/a?alt=media"
        );
    }

    #[test]
    fn rewrite_replaces_only_resolved_urls() {
        let markdown = "![](https://firebasestorage.googleapis.com/o/a?alt=media\\&token=t) and [f](https://firebasestorage.googleapis.com/o/b?alt=media\\&token=u)";
        let replacements = HashMap::from([(
            "https://firebasestorage.googleapis.com/o/a?alt=media&token=t".to_string(),
            "assets/photo.webp".to_string(),
        )]);
        assert_eq!(
            rewrite_markdown(markdown, PREFIX, &replacements),
            "![](assets/photo.webp) and [f](https://firebasestorage.googleapis.com/o/b?alt=media\\&token=u)"
        );
    }

    #[test]
    fn content_disposition_prefers_rfc5987() {
        assert_eq!(
            content_disposition_filename(
                "inline; filename*=UTF-8''caf%C3%A9%20menu.pdf; filename=\"fallback.pdf\""
            ),
            Some("café menu.pdf".to_string())
        );
        assert_eq!(
            content_disposition_filename("inline; filename=\"photo.webp\""),
            Some("photo.webp".to_string())
        );
        assert_eq!(content_disposition_filename("inline"), None);
    }

    #[test]
    fn object_id_decodes_the_firebase_path() {
        assert_eq!(
            url_object_id(
                "https://firebasestorage.googleapis.com/v0/b/x/o/users%2Fabc%2Fd8fbbe?alt=media"
            ),
            Some("d8fbbe".to_string())
        );
    }

    #[test]
    fn sanitize_mirrors_the_typescript_rules() {
        assert_eq!(
            sanitize_asset_file_name("Q3 Report (final).PDF"),
            "q3-report-final.pdf"
        );
        assert_eq!(sanitize_asset_file_name("archive.tar.gz"), "archive-tar.gz");
        assert_eq!(sanitize_asset_file_name(".env"), "env");
        assert_eq!(sanitize_asset_file_name("???"), "untitled");
        assert_eq!(sanitize_asset_file_name("con.pdf"), "con-note.pdf");
        assert_eq!(
            sanitize_asset_file_name("日本語 メモ.png"),
            "日本語-メモ.png"
        );
    }

    #[test]
    fn plan_reuses_identical_bytes_and_probes_conflicts() {
        let dir = tempdir().unwrap();
        let assets = dir.path().join("assets");
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("photo.webp"), b"same").unwrap();
        fs::write(dir.path().join("staged"), b"same").unwrap();
        fs::write(dir.path().join("other"), b"different").unwrap();

        let planned = plan_asset_name(
            &assets,
            "photo.webp",
            &dir.path().join("staged"),
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(planned.name, "photo.webp");
        assert!(planned.reuse);

        let planned = plan_asset_name(
            &assets,
            "photo.webp",
            &dir.path().join("other"),
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(planned.name, "photo-2.webp");
        assert!(!planned.reuse);

        let taken = HashSet::from(["photo-2.webp".to_string()]);
        let planned =
            plan_asset_name(&assets, "photo.webp", &dir.path().join("other"), &taken).unwrap();
        assert_eq!(planned.name, "photo-3.webp");
        assert!(!planned.reuse);
    }
}
