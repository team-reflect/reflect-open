//! Reflect V1 export import.
//!
//! Reflect V1 now exports the same markdown graph layout Reflect Open reads:
//! `daily/`, `notes/`, optional `assets/`, plus ignorable local metadata. The
//! import path is therefore a bounded archive extraction into the active graph,
//! not a content migration — with one addition: attachments the notes link
//! straight to Firebase Storage are downloaded into `assets/` and the links
//! rewritten (see [`super::import_assets`]).
//!
//! The flow is three phases so nothing lands in the graph until everything is
//! in hand: [`prepare_zip_import`] (read + validate, no writes), the async
//! [`PreparedImport::download_assets`] (network, staging writes only), then
//! [`finalize_import`] (rewrite, collision-check, atomic writes).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::import_assets::{self, DownloadOutcome};
use super::io::{atomic_write_bytes, file_occupied};
use super::resolve::resolve;

/// Summary returned to the settings UI after an import completes.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Zip files newly written to the open graph.
    pub imported_files: usize,
    /// Zip files already present with identical bytes, left untouched.
    pub skipped_files: usize,
    /// Remote attachments now stored locally under `assets/` (whether newly
    /// written or already present from an earlier import).
    pub downloaded_assets: usize,
    /// Remote attachments that are permanently gone (4xx); their notes keep
    /// the remote link.
    pub failed_asset_downloads: usize,
    /// Graph-relative paths newly written to the open graph.
    pub changed_paths: Vec<String>,
}

struct ImportEntry {
    relative: String,
    bytes: Vec<u8>,
}

/// A validated export, read out of the zip but not yet written anywhere.
pub struct PreparedImport {
    entries: Vec<ImportEntry>,
    staging: PathBuf,
    /// Unique remote-asset URLs across all notes, in first-seen order (which
    /// also fixes collision-suffix assignment).
    urls: Vec<String>,
    prefix: String,
}

impl PreparedImport {
    /// Download every remote attachment into the graph's staging directory.
    /// Transient failures abort (nothing has been written to the graph yet);
    /// permanent 4xx failures come back as [`DownloadOutcome::Gone`].
    pub async fn download_assets(&self) -> AppResult<HashMap<String, DownloadOutcome>> {
        import_assets::download_remote_assets(&self.staging, self.urls.clone()).await
    }
}

/// Read and validate a user-selected Reflect V1 export zip against `root`,
/// without writing anything.
pub(super) fn prepare_zip_import(root: &Path, zip_path: &Path) -> AppResult<PreparedImport> {
    prepare_zip_import_from(root, zip_path, import_assets::V1_ASSET_URL_PREFIX)
}

/// [`prepare_zip_import`] with the remote-asset URL prefix injectable, so
/// tests can point it at a local server.
fn prepare_zip_import_from(
    root: &Path,
    zip_path: &Path,
    prefix: &str,
) -> AppResult<PreparedImport> {
    let entries = dedupe_entries(read_zip_entries(zip_path)?)?;
    ensure_has_notes(&entries)?;
    let mut seen = HashSet::new();
    let mut urls = Vec::new();
    for entry in &entries {
        if !is_note_markdown(&entry.relative) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&entry.bytes) else {
            continue;
        };
        for span in import_assets::scan_remote_spans(text, prefix) {
            if seen.insert(span.url.clone()) {
                urls.push(span.url);
            }
        }
    }
    Ok(PreparedImport {
        entries,
        staging: super::assets::staging_dir(root)?,
        urls,
        prefix: prefix.to_string(),
    })
}

/// Two distinct URLs can serve the same attachment (V1 stored one upload per
/// link). When a download matches an already-planned asset's name and bytes,
/// both links share that one file instead of persisting a `-2` duplicate.
fn planned_duplicate(
    planned: &[(import_assets::FetchedAsset, import_assets::PlannedAssetName)],
    fetched: &import_assets::FetchedAsset,
) -> AppResult<Option<String>> {
    for (prior, plan) in planned {
        if prior.desired_name == fetched.desired_name
            && import_assets::same_file_bytes(prior.file.as_ref(), fetched.file.as_ref())?
        {
            return Ok(Some(plan.name.clone()));
        }
    }
    Ok(None)
}

fn ensure_has_notes(entries: &[ImportEntry]) -> AppResult<()> {
    if !entries
        .iter()
        .any(|entry| is_note_markdown(&entry.relative))
    {
        return Err(AppError::not_found(
            "that doesn't look like a Reflect V1 export — no notes found under daily/ or notes/",
        ));
    }
    Ok(())
}

/// Localize the downloaded attachments, rewrite the notes' remote links to
/// `assets/…` paths, then write everything into the graph with the same
/// collision policy as before: never overwrite a differing existing file,
/// skip identical ones.
pub(super) fn finalize_import(
    root: &Path,
    prepared: PreparedImport,
    mut outcomes: HashMap<String, DownloadOutcome>,
) -> AppResult<ImportSummary> {
    let PreparedImport {
        mut entries,
        urls,
        prefix,
        ..
    } = prepared;

    let assets_dir = root.join("assets");
    let mut replacements = HashMap::new();
    let mut planned: Vec<(import_assets::FetchedAsset, import_assets::PlannedAssetName)> =
        Vec::new();
    let mut taken = HashSet::new();
    let mut downloaded_assets = 0;
    let mut failed_asset_downloads = 0;
    for url in &urls {
        match outcomes.remove(url) {
            Some(DownloadOutcome::Fetched(fetched)) => {
                downloaded_assets += 1;
                if let Some(name) = planned_duplicate(&planned, &fetched)? {
                    replacements.insert(url.clone(), format!("assets/{name}"));
                    continue;
                }
                let plan = import_assets::plan_asset_name(
                    &assets_dir,
                    &fetched.desired_name,
                    fetched.file.as_ref(),
                    &taken,
                )?;
                taken.insert(plan.name.clone());
                replacements.insert(url.clone(), format!("assets/{}", plan.name));
                planned.push((fetched, plan));
            }
            Some(DownloadOutcome::Gone) => failed_asset_downloads += 1,
            None => {}
        }
    }

    if !replacements.is_empty() {
        for entry in &mut entries {
            if !is_note_markdown(&entry.relative) {
                continue;
            }
            let Ok(text) = std::str::from_utf8(&entry.bytes) else {
                continue;
            };
            let rewritten = import_assets::rewrite_markdown(text, &prefix, &replacements);
            if rewritten != text {
                entry.bytes = rewritten.into_bytes();
            }
        }
    }

    let collisions = entries
        .iter()
        .map(|entry| collision(root, entry))
        .collect::<AppResult<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !collisions.is_empty() {
        return Err(AppError::io(format!(
            "import would overwrite existing files: {}",
            collisions
                .iter()
                .take(5)
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    let mut imported_files = 0;
    let mut skipped_files = 0;
    let mut changed_paths = Vec::new();
    for (fetched, plan) in planned {
        if plan.reuse {
            continue;
        }
        import_assets::persist_planned(fetched, &assets_dir, &plan.name)?;
        changed_paths.push(format!("assets/{}", plan.name));
    }
    for entry in entries {
        let target = resolve(root, &entry.relative)?;
        if let Some(path) = collision(root, &entry)? {
            return Err(AppError::io(format!(
                "import would overwrite existing files: {path}"
            )));
        }
        if target.is_file() && fs::read(&target)? == entry.bytes {
            skipped_files += 1;
            continue;
        }
        atomic_write_bytes(root, &target, &entry.bytes)?;
        imported_files += 1;
        changed_paths.push(entry.relative);
    }

    Ok(ImportSummary {
        imported_files,
        skipped_files,
        downloaded_assets,
        failed_asset_downloads,
        changed_paths,
    })
}

fn dedupe_entries(entries: Vec<ImportEntry>) -> AppResult<Vec<ImportEntry>> {
    let mut positions = HashMap::<String, usize>::new();
    let mut unique = Vec::<ImportEntry>::new();
    for entry in entries {
        if let Some(existing) = positions.get(&entry.relative) {
            if unique[*existing].bytes != entry.bytes {
                return Err(AppError::io(format!(
                    "import zip contains conflicting entries for {}",
                    entry.relative
                )));
            }
            continue;
        }
        positions.insert(entry.relative.clone(), unique.len());
        unique.push(entry);
    }
    Ok(unique)
}

fn collision(root: &Path, entry: &ImportEntry) -> AppResult<Option<String>> {
    let target = resolve(root, &entry.relative)?;
    if !target.exists() && !file_occupied(&target) {
        return Ok(None);
    }
    if target.is_file() && fs::read(&target)? == entry.bytes {
        return Ok(None);
    }
    Ok(Some(entry.relative.clone()))
}

fn read_zip_entries(path: &Path) -> AppResult<Vec<ImportEntry>> {
    let file = fs::File::open(path).map_err(|err| {
        AppError::io(format!(
            "could not open Reflect V1 export {}: {err}",
            path.display()
        ))
    })?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| AppError::io(format!("could not read the zip: {err}")))?;

    let mut names = Vec::new();
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|err| AppError::io(format!("could not read a zip entry: {err}")))?;
        if file.is_dir() {
            continue;
        }
        if let Some(name) = file.enclosed_name() {
            names.push(normalize_zip_path(&name.to_string_lossy()));
        }
    }

    let prefix = wrapper_prefix(&names);
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| AppError::io(format!("could not read a zip entry: {err}")))?;
        if file.is_dir() {
            continue;
        }
        let Some(name) = file.enclosed_name() else {
            continue;
        };
        let name = normalize_zip_path(&name.to_string_lossy());
        let Some(relative) = sanitized_relative(&name, prefix.as_deref()) else {
            continue;
        };
        let mut bytes = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut bytes)
            .map_err(|err| AppError::io(format!("could not extract {relative}: {err}")))?;
        entries.push(ImportEntry { relative, bytes });
    }
    Ok(entries)
}

fn normalize_zip_path(path: &str) -> String {
    path.replace('\\', "/")
}

/// A single wrapping directory commonly added by zip tools:
/// `export/notes/a.md` should import as `notes/a.md`.
fn wrapper_prefix(paths: &[String]) -> Option<String> {
    let mut shared: Option<&str> = None;
    for path in paths {
        let parts = parts(path);
        if is_ignored_wrapper_noise(&parts) {
            continue;
        }
        let first = *parts.first()?;
        match shared {
            None => shared = Some(first),
            Some(existing) if existing == first => {}
            Some(_) => return None,
        }
    }
    let shared = shared?;
    if matches!(shared, "daily" | "notes" | "assets" | ".reflect") {
        return None;
    }
    Some(shared.to_string())
}

fn sanitized_relative(raw: &str, prefix: Option<&str>) -> Option<String> {
    if raw.starts_with('/') || raw.contains('\0') {
        return None;
    }
    let normalized = normalize_zip_path(raw);
    let mut parts = parts(&normalized);
    if parts.contains(&"..") {
        return None;
    }
    if let Some(prefix) = prefix {
        if parts.first() == Some(&prefix) {
            parts.remove(0);
        }
    }
    if is_ignored_wrapper_noise(&parts) {
        return None;
    }
    let first = *parts.first()?;
    let last = *parts.last()?;
    if matches!(first, ".reflect" | ".git" | "__MACOSX") || is_junk(last) {
        return None;
    }
    Some(parts.join("/"))
}

fn parts(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect()
}

fn is_ignored_wrapper_noise(parts: &[&str]) -> bool {
    match parts {
        [] => true,
        [".gitignore"] => true,
        [name] if is_junk(name) => true,
        [first, ..] if *first == "__MACOSX" => true,
        _ => false,
    }
}

fn is_junk(name: &str) -> bool {
    name == ".DS_Store"
        || name == "Thumbs.db"
        || name == "Desktop.ini"
        || name.ends_with(".swp")
        || name.ends_with(".swo")
        || name.ends_with('~')
}

fn is_note_markdown(relative: &str) -> bool {
    let mut parts = relative.split('/');
    let Some(first) = parts.next() else {
        return false;
    };
    matches!(first, "daily" | "notes")
        && Path::new(relative)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn entries(pairs: &[(&str, &str)]) -> Vec<ImportEntry> {
        pairs
            .iter()
            .filter_map(|(path, contents)| {
                sanitized_relative(path, None).map(|relative| ImportEntry {
                    relative,
                    bytes: contents.as_bytes().to_vec(),
                })
            })
            .collect()
    }

    /// The old single-call import shape, for tests that exercise extraction
    /// and collision policy without remote assets.
    fn import_entries_into_graph(
        root: &Path,
        entries: Vec<ImportEntry>,
    ) -> AppResult<ImportSummary> {
        let entries = dedupe_entries(entries)?;
        ensure_has_notes(&entries)?;
        let prepared = PreparedImport {
            entries,
            staging: super::super::assets::staging_dir(root)?,
            urls: Vec::new(),
            prefix: import_assets::V1_ASSET_URL_PREFIX.to_string(),
        };
        finalize_import(root, prepared, HashMap::new())
    }

    fn import_zip_into_graph(root: &Path, zip_path: &Path) -> AppResult<ImportSummary> {
        let prepared = prepare_zip_import(root, zip_path)?;
        finalize_import(root, prepared, HashMap::new())
    }

    fn write_zip(path: &Path, pairs: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, contents) in pairs {
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    /// Serve canned HTTP responses on a local port: each entry is
    /// `(path, status line, extra headers, body)`. Handles connections until
    /// the expected request count is reached.
    fn serve(
        responses: Vec<(&'static str, &'static str, &'static str, &'static [u8])>,
        expected_requests: usize,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for _ in 0..expected_requests {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                }
                let requested = request_line.split_whitespace().nth(1).unwrap_or("");
                let mut stream = reader.into_inner();
                match responses.iter().find(|(path, ..)| *path == requested) {
                    Some((_, status, headers, body)) => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(body);
                    }
                    None => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                        );
                    }
                }
            }
        });
        base
    }

    fn serve_generated_assets(expected_requests: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for _ in 0..expected_requests {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                }
                let requested = request_line.split_whitespace().nth(1).unwrap_or("");
                let body = requested.as_bytes();
                let mut stream = reader.into_inner();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: image/png\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(body);
            }
        });
        base
    }

    #[cfg(unix)]
    fn open_fd_count() -> Option<usize> {
        ["/proc/self/fd", "/dev/fd"]
            .into_iter()
            .find_map(|path| fs::read_dir(path).ok().map(|entries| entries.count()))
    }

    #[test]
    fn imports_notes_into_the_open_graph() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[
                ("notes/a.md", "# A\n"),
                ("daily/2026-07-04.md", "Today\n"),
                ("assets/pic.bin", "raw"),
            ]),
        )
        .unwrap();

        assert_eq!(
            summary,
            ImportSummary {
                imported_files: 3,
                skipped_files: 0,
                downloaded_assets: 0,
                failed_asset_downloads: 0,
                changed_paths: vec![
                    "notes/a.md".to_string(),
                    "daily/2026-07-04.md".to_string(),
                    "assets/pic.bin".to_string()
                ],
            }
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# A\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap(),
            "Today\n"
        );
        assert_eq!(
            fs::read(root.path().join("assets/pic.bin")).unwrap(),
            b"raw"
        );
    }

    #[test]
    fn skips_metadata_and_strips_a_wrapper_directory() {
        let root = tempdir().unwrap();
        let zip_path = root.path().join("export.zip");
        write_zip(
            &zip_path,
            &[
                ("Reflect/.gitignore", "ignored"),
                ("Reflect/.reflect/index.sqlite", "stale"),
                ("Reflect/.git/config", "git"),
                ("Reflect/notes/.DS_Store", "junk"),
                ("Reflect/notes/a.md", "# A\n"),
            ],
        );

        let summary = import_zip_into_graph(root.path(), &zip_path).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert!(root.path().join("notes/a.md").is_file());
        assert!(!root.path().join(".reflect/index.sqlite").exists());
        assert!(!root.path().join(".git/config").exists());
        assert!(!root.path().join("notes/.DS_Store").exists());
    }

    #[test]
    fn refuses_to_overwrite_existing_files() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();

        let result = import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# V1\n")]));

        match result.unwrap_err() {
            AppError::Io { message } => assert!(message.contains("notes/a.md")),
            other => panic!("expected an IO collision error, got {other:?}"),
        }
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# Mine\n"
        );
    }

    #[test]
    fn identical_existing_files_are_skipped() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/a.md"), "# Same\n").unwrap();

        let summary =
            import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# Same\n")])).unwrap();

        assert_eq!(
            summary,
            ImportSummary {
                imported_files: 0,
                skipped_files: 1,
                downloaded_assets: 0,
                failed_asset_downloads: 0,
                changed_paths: Vec::new(),
            }
        );
    }

    #[test]
    fn identical_duplicate_entries_import_once() {
        let root = tempdir().unwrap();

        let summary = import_entries_into_graph(
            root.path(),
            entries(&[("notes/a.md", "# Same\n"), ("notes/a.md", "# Same\n")]),
        )
        .unwrap();

        assert_eq!(
            summary,
            ImportSummary {
                imported_files: 1,
                skipped_files: 0,
                downloaded_assets: 0,
                failed_asset_downloads: 0,
                changed_paths: vec!["notes/a.md".to_string()],
            }
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# Same\n"
        );
    }

    #[test]
    fn conflicting_duplicate_entries_reject_before_writing() {
        let root = tempdir().unwrap();

        let result = import_entries_into_graph(
            root.path(),
            entries(&[("notes/a.md", "# First\n"), ("notes/a.md", "# Second\n")]),
        );

        match result.unwrap_err() {
            AppError::Io { message } => assert!(message.contains("conflicting entries")),
            other => panic!("expected a duplicate-entry IO error, got {other:?}"),
        }
        assert!(!root.path().join("notes/a.md").exists());
    }

    #[test]
    fn evicted_icloud_placeholder_blocks_import() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::write(root.path().join("notes/.a.md.icloud"), "placeholder").unwrap();

        let result = import_entries_into_graph(root.path(), entries(&[("notes/a.md", "# V1\n")]));

        match result.unwrap_err() {
            AppError::Io { message } => assert!(message.contains("notes/a.md")),
            other => panic!("expected a placeholder collision error, got {other:?}"),
        }
        assert!(!root.path().join("notes/a.md").exists());
        assert!(root.path().join("notes/.a.md.icloud").exists());
    }

    #[test]
    fn rejects_archives_without_notes() {
        let root = tempdir().unwrap();

        let result = import_entries_into_graph(root.path(), entries(&[("assets/pic.bin", "raw")]));

        assert!(result.is_err());
        assert!(!root.path().join("assets/pic.bin").exists());
    }

    fn import_zip_downloading_from(
        root: &Path,
        zip_path: &Path,
        prefix: &str,
    ) -> AppResult<ImportSummary> {
        let prepared = prepare_zip_import_from(root, zip_path, prefix)?;
        let downloads = tauri::async_runtime::block_on(prepared.download_assets())?;
        finalize_import(root, prepared, downloads)
    }

    #[test]
    fn downloads_remote_assets_and_rewrites_links() {
        let root = tempdir().unwrap();
        let base = serve(
            vec![
                (
                    "/photo?alt=media&token=t",
                    "200 OK",
                    "Content-Type: image/webp\r\nContent-Disposition: inline; filename=\"Trip Photo.webp\"\r\n",
                    b"webp bytes",
                ),
                (
                    "/memo?alt=media&token=u",
                    "200 OK",
                    "Content-Type: audio/mp4\r\n",
                    b"audio bytes",
                ),
                (
                    "/users%2Fabc%2F9c2c28?alt=media&token=v",
                    "200 OK",
                    "Content-Type: image/png\r\nContent-Disposition: inline; filename*=utf-8''9c2c28\r\n",
                    b"png bytes",
                ),
            ],
            3,
        );
        let zip_path = root.path().join("export.zip");
        let markdown = format!(
            "![]({base}photo?alt=media\\&token=t)\n\n[memo.m4a]({base}memo?alt=media\\&token=u)\n\n![]({base}users%2Fabc%2F9c2c28?alt=media\\&token=v)\n"
        );
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let summary = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.downloaded_assets, 3);
        assert_eq!(summary.failed_asset_downloads, 0);
        assert!(summary
            .changed_paths
            .contains(&"assets/trip-photo.webp".to_string()));
        assert!(summary
            .changed_paths
            .contains(&"assets/memo.m4a".to_string()));
        assert_eq!(
            fs::read(root.path().join("assets/trip-photo.webp")).unwrap(),
            b"webp bytes"
        );
        assert_eq!(
            fs::read(root.path().join("assets/memo.m4a")).unwrap(),
            b"audio bytes"
        );
        assert_eq!(
            fs::read(root.path().join("assets/9c2c28.png")).unwrap(),
            b"png bytes"
        );
        let note = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert_eq!(
            note,
            "![](assets/trip-photo.webp)\n\n[memo.m4a](assets/memo.m4a)\n\n![](assets/9c2c28.png)\n"
        );
    }

    #[test]
    #[cfg(unix)]
    fn downloaded_assets_do_not_hold_file_descriptors_until_finalize() {
        const ASSET_COUNT: usize = 80;

        let root = tempdir().unwrap();
        let base = serve_generated_assets(ASSET_COUNT);
        let zip_path = root.path().join("export.zip");
        let markdown = (0..ASSET_COUNT)
            .map(|index| format!("![]({base}asset-{index}?alt=media\\&token={index})\n"))
            .collect::<String>();
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let prepared = prepare_zip_import_from(root.path(), &zip_path, &base).unwrap();
        let Some(before) = open_fd_count() else {
            return;
        };
        let downloads = tauri::async_runtime::block_on(prepared.download_assets()).unwrap();
        let Some(after) = open_fd_count() else {
            return;
        };

        assert_eq!(downloads.len(), ASSET_COUNT);
        assert!(
            after.saturating_sub(before) < ASSET_COUNT / 4,
            "asset downloads kept too many file descriptors open: before {before}, after {after}"
        );

        let summary = finalize_import(root.path(), prepared, downloads).unwrap();
        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.downloaded_assets, ASSET_COUNT);
        assert_eq!(summary.failed_asset_downloads, 0);
        assert_eq!(
            summary
                .changed_paths
                .iter()
                .filter(|path| path.starts_with("assets/"))
                .count(),
            ASSET_COUNT
        );
    }

    #[test]
    fn identical_assets_under_one_name_share_one_file() {
        let root = tempdir().unwrap();
        let response: (&str, &str, &str, &[u8]) = (
            "",
            "200 OK",
            "Content-Type: image/png\r\nContent-Disposition: inline; filename=\"pic.png\"\r\n",
            b"png bytes",
        );
        let base = serve(
            vec![
                ("/a?alt=media&token=t", response.1, response.2, response.3),
                ("/b?alt=media&token=u", response.1, response.2, response.3),
            ],
            2,
        );
        let zip_path = root.path().join("export.zip");
        let markdown =
            format!("![]({base}a?alt=media\\&token=t)\n\n![]({base}b?alt=media\\&token=u)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let summary = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();

        assert_eq!(summary.downloaded_assets, 2);
        let asset_paths: Vec<_> = summary
            .changed_paths
            .iter()
            .filter(|path| path.starts_with("assets/"))
            .collect();
        assert_eq!(asset_paths, ["assets/pic.png"]);
        assert!(!root.path().join("assets/pic-2.png").exists());
        let note = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert_eq!(note, "![](assets/pic.png)\n\n![](assets/pic.png)\n");
    }

    #[test]
    fn gone_assets_keep_their_remote_links() {
        let root = tempdir().unwrap();
        let base = serve(vec![], 1);
        let zip_path = root.path().join("export.zip");
        let markdown = format!("![]({base}deleted?alt=media\\&token=t)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let summary = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();

        assert_eq!(summary.imported_files, 1);
        assert_eq!(summary.downloaded_assets, 0);
        assert_eq!(summary.failed_asset_downloads, 1);
        let note = fs::read_to_string(root.path().join("daily/2026-07-04.md")).unwrap();
        assert_eq!(note, markdown);
        assert!(!root.path().join("assets").join("deleted").exists());
    }

    #[test]
    fn unreachable_asset_host_aborts_before_any_write() {
        let root = tempdir().unwrap();
        // Bind then drop, so the port refuses connections.
        let dead = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/", dead.local_addr().unwrap());
        drop(dead);
        let zip_path = root.path().join("export.zip");
        let markdown = format!("![]({base}photo?alt=media\\&token=t)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let result = import_zip_downloading_from(root.path(), &zip_path, &base);

        assert!(matches!(result.unwrap_err(), AppError::Network { .. }));
        assert!(!root.path().join("daily/2026-07-04.md").exists());
    }

    #[test]
    fn reimporting_the_same_export_reuses_downloaded_assets() {
        let root = tempdir().unwrap();
        let base = serve(
            vec![(
                "/photo?alt=media&token=t",
                "200 OK",
                "Content-Type: image/png\r\nContent-Disposition: inline; filename=\"pic.png\"\r\n",
                b"png bytes",
            )],
            2,
        );
        let zip_path = root.path().join("export.zip");
        let markdown = format!("![]({base}photo?alt=media\\&token=t)\n");
        write_zip(&zip_path, &[("daily/2026-07-04.md", markdown.as_str())]);

        let first = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();
        assert_eq!(first.imported_files, 1);
        assert_eq!(first.downloaded_assets, 1);

        let second = import_zip_downloading_from(root.path(), &zip_path, &base).unwrap();
        assert_eq!(second.imported_files, 0);
        assert_eq!(second.skipped_files, 1);
        assert_eq!(second.downloaded_assets, 1);
        assert!(second.changed_paths.is_empty());
        assert!(!root.path().join("assets/pic-2.png").exists());
    }

    #[test]
    fn wrapper_prefix_ignores_root_metadata_noise() {
        assert_eq!(
            wrapper_prefix(&[
                ".DS_Store".to_string(),
                ".gitignore".to_string(),
                "export/notes/a.md".to_string()
            ]),
            Some("export".to_string())
        );
        assert_eq!(
            wrapper_prefix(&["notes/a.md".to_string(), "daily/2026-07-04.md".to_string()]),
            None
        );
    }
}
