//! Link-capture primitives (Plan 11): the capture-inbox commands the drain
//! action composes, the screenshot promote/downscale step, the bounded
//! meta-scrape fetch, and the native-messaging plumbing (pointer file +
//! browser host manifests) that lets the `reflect-capture-host` sidecar spool
//! captures while this app is closed. Policy — what gets written where, the
//! privacy gate, enrichment — lives in `@reflect/core` (`actions/capture`);
//! this module only moves bytes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::{current_root, modified_ms, root_for_generation, FileMeta, GraphState};

/// The native-messaging host name browsers route on; must match the name the
/// extension passes to `runtime.sendNativeMessage`.
#[cfg(any(target_os = "macos", test))]
const HOST_NAME: &str = "app.reflect.capture";

/// The sidecar binary, staged beside the app binary by the Tauri bundler (and
/// beside the dev binary by `tauri dev`).
#[cfg(target_os = "macos")]
const HOST_BINARY: &str = "reflect-capture-host";

/// Extension IDs allowed to launch the host. The first is the dev/unpacked ID,
/// pinned by the `key` field in `apps/extension/wxt.config.ts`; the second is
/// the published Chrome Web Store listing.
#[cfg(any(target_os = "macos", test))]
const EXTENSION_ORIGINS: [&str; 2] = [
    "chrome-extension://dlbliojklpickgimjdmjjdnbjdiomjik/",
    "chrome-extension://ccabifmooehighoonjeiololjfofkhkd/",
];

/// Graph-relative spool directory the host writes and the drain reads.
const INBOX_DIR: &str = ".reflect/inbox";

// ---- pointer file ------------------------------------------------------------

/// Where the host discovers the active graph. Same app-data directory as
/// `settings.rs`/`recents.rs`; the shape is versioned so a future change reads
/// as a typed host error, never a silent mis-spool.
fn pointer_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir"))?;
    Ok(base.join("reflect-open").join("capture-pointer.json"))
}

fn pointer_json(root: &Path) -> String {
    serde_json::json!({
        "version": 1,
        "graphRoot": root.to_string_lossy(),
    })
    .to_string()
}

// Also used by `skill.rs` for the agent-skill files under `~/.agents/`.
pub(crate) fn atomic_write_to(path: &Path, contents: &str) -> AppResult<()> {
    atomic_write_bytes_to(path, contents.as_bytes())
}

fn atomic_write_bytes_to(path: &Path, contents: &[u8]) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::io(format!("no parent directory for {}", path.display())))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    tmp.flush()?;
    tmp.persist(path)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

// ---- browser manifests (macOS) ------------------------------------------------
//
// Everything here is `cfg(target_os = "macos")` (plus `test`, so the rules
// stay unit-tested on every CI platform): the first release registers
// manifests on macOS only — Windows registry keys and Linux paths land with
// Plan 15 packaging.

/// The native-messaging manifest content for a host binary at `host_path`.
#[cfg(any(target_os = "macos", test))]
fn host_manifest_json(host_path: &Path) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Reflect link capture",
        "path": host_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": EXTENSION_ORIGINS,
    }))
    .expect("static manifest serializes")
}

/// Chromium-family browser data dirs under `~/Library/Application Support`
/// that may carry a `NativeMessagingHosts/` directory. Arc keeps its own under
/// `User Data`, matching Chrome's profile layout.
#[cfg(any(target_os = "macos", test))]
const MACOS_BROWSER_DIRS: [&str; 10] = [
    "Google/Chrome",
    "Google/Chrome Beta",
    "Google/Chrome Dev",
    "Google/Chrome Canary",
    "Chromium",
    "Microsoft Edge",
    "BraveSoftware/Brave-Browser",
    "Vivaldi",
    "com.operasoftware.Opera",
    "Arc/User Data",
];

/// `NativeMessagingHosts/` dirs for browsers actually present under
/// `app_support` — manifests are only written for detected browsers (spraying
/// them for uninstalled ones is the Claude-Desktop mistake the spike calls
/// out). Pure given the base dir, so the detection rule is unit-testable.
#[cfg(any(target_os = "macos", test))]
fn detected_manifest_dirs(app_support: &Path) -> Vec<PathBuf> {
    MACOS_BROWSER_DIRS
        .iter()
        .map(|dir| app_support.join(dir))
        .filter(|dir| dir.is_dir())
        .map(|dir| dir.join("NativeMessagingHosts"))
        .collect()
}

/// Write (or rewrite) the host manifest for every detected browser. Runs on
/// every launch and graph switch — rewriting self-heals app moves and macOS
/// app translocation, per the bridge spike.
#[cfg(any(target_os = "macos", test))]
fn register_manifests(app_support: &Path, host_path: &Path) -> AppResult<usize> {
    let manifest = host_manifest_json(host_path);
    let mut written = 0;
    for dir in detected_manifest_dirs(app_support) {
        fs::create_dir_all(&dir)?;
        atomic_write_to(&dir.join(format!("{HOST_NAME}.json")), &manifest)?;
        written += 1;
    }
    Ok(written)
}

/// The staged host binary, next to the running executable in both dev
/// (`target/debug/`) and the bundle (`Reflect.app/Contents/MacOS/`).
#[cfg(target_os = "macos")]
fn host_binary_path() -> AppResult<PathBuf> {
    let exe = std::env::current_exe().map_err(|err| AppError::io(err.to_string()))?;
    let dir = exe
        .parent()
        .ok_or_else(|| AppError::io("executable has no parent directory"))?;
    Ok(dir.join(HOST_BINARY))
}

/// Point the capture host at the active graph and register browser manifests.
/// Called by the frontend after every graph open. Manifest registration is
/// macOS-only for now (the first release ships macOS; Windows registry keys
/// and Linux paths land with Plan 15 packaging).
#[tauri::command]
pub fn capture_host_register(state: State<GraphState>) -> AppResult<()> {
    let root = current_root(&state)?;
    fs::create_dir_all(root.join(INBOX_DIR))?;
    atomic_write_to(&pointer_path()?, &pointer_json(&root))?;

    #[cfg(target_os = "macos")]
    {
        let host_path = host_binary_path()?;
        if !host_path.is_file() {
            // Dev builds before the sidecar is staged: registration would point
            // browsers at a missing binary, so skip loudly instead.
            tracing::warn!(path = %host_path.display(), "capture host binary not staged; skipping manifest registration");
            return Ok(());
        }
        let app_support = dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir"))?;
        let written = register_manifests(&app_support, &host_path)?;
        tracing::info!(written, "registered capture host manifests");
    }
    Ok(())
}

// ---- inbox commands -----------------------------------------------------------

/// Spool filenames are host-written `<uuid>.json` / `<uuid>.jpg`; anything
/// with a path separator (or a stray name another process dropped in) is
/// refused before it can address outside the inbox.
fn inbox_file(root: &Path, name: &str) -> AppResult<PathBuf> {
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(AppError::traversal(format!(
            "not a spool filename: {name:?}"
        )));
    }
    Ok(root.join(INBOX_DIR).join(name))
}

/// List the capture inbox (flat; `.json` envelopes and their screenshot
/// siblings). A missing inbox lists as empty — the host creates it lazily.
#[tauri::command]
pub fn capture_inbox_list(generation: u64, state: State<GraphState>) -> AppResult<Vec<FileMeta>> {
    let root = root_for_generation(&state, generation)?;
    let inbox = root.join(INBOX_DIR);
    let mut out = Vec::new();
    let entries = match fs::read_dir(&inbox) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(err) => return Err(err.into()),
    };
    for entry in entries {
        let entry = entry?;
        let meta = entry.metadata()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !meta.is_file() || name.starts_with('.') {
            continue; // host tmp files and directories are not spool entries
        }
        out.push(FileMeta {
            path: format!("{INBOX_DIR}/{name}"),
            size: meta.len(),
            modified_ms: modified_ms(&meta).unwrap_or(0),
            placeholder: false, // the inbox lives under `.reflect/`, never synced/evicted
        });
    }
    out.sort_by(|first, second| first.path.cmp(&second.path));
    Ok(out)
}

/// Envelopes this app spools itself (deep-link captures) are one short text
/// payload — anything near this cap is not a capture, it's smuggling.
const INBOX_SPOOL_MAX_BYTES: usize = 64 * 1024;

fn ensure_spool_size(json: &str) -> AppResult<()> {
    if json.len() > INBOX_SPOOL_MAX_BYTES {
        return Err(AppError::parse(format!(
            "envelope exceeds the {INBOX_SPOOL_MAX_BYTES}-byte spool cap"
        )));
    }
    Ok(())
}

/// Spool an envelope this app produced (deep-link `append`/`task` URLs) into
/// the same inbox the native-messaging host writes, so it flows through the
/// one drain path. The frontend owns the envelope shape; this only moves
/// bytes — atomically, so a half-written file can never be drained.
#[tauri::command]
pub fn capture_inbox_spool(
    name: String,
    json: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    ensure_spool_size(&json)?;
    let root = root_for_generation(&state, generation)?;
    atomic_write_to(&inbox_file(&root, &name)?, &json)
}

/// Read one spooled envelope's JSON text by spool filename.
#[tauri::command]
pub fn capture_inbox_read(
    name: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<String> {
    let root = root_for_generation(&state, generation)?;
    Ok(fs::read_to_string(inbox_file(&root, &name)?)?)
}

/// Remove a spool file. Idempotent — a re-drain after a crash may remove a
/// file the crashed pass already removed.
#[tauri::command]
pub fn capture_inbox_remove(
    name: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    let root = root_for_generation(&state, generation)?;
    match fs::remove_file(inbox_file(&root, &name)?) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// Where the drain quarantines spool files it cannot parse. Outside
/// `.reflect/inbox/`, so nothing here re-triggers the watcher or a drain.
const INBOX_REJECTED_DIR: &str = ".reflect/inbox-rejected";

fn quarantine_spool(root: &Path, name: &str) -> AppResult<()> {
    let source = inbox_file(root, name)?;
    let rejected = root.join(INBOX_REJECTED_DIR);
    fs::create_dir_all(&rejected)?;
    match fs::rename(&source, rejected.join(name)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// Quarantine a spool file the drain cannot parse — moved, never deleted:
/// "the raw link is never lost" must hold even for an envelope written by a
/// newer extension this app version cannot read yet. Idempotent like
/// `capture_inbox_remove`; an existing quarantined file of the same name is
/// replaced (same capture id ⇒ same content).
#[tauri::command]
pub fn capture_inbox_reject(
    name: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    quarantine_spool(&root_for_generation(&state, generation)?, &name)
}

// ---- iOS App Group shared inbox ---------------------------------------------

/// The App Group the iOS share extension spools into. Must match the
/// `com.apple.security.application-groups` entitlement on the app and the
/// extension targets (`ios.project.yml`) and `groupId` in
/// `CaptureInbox.swift`. Debug builds are the dev flavor and use their own
/// group so a dev install never drains the production app's inbox; the Xcode
/// debug configuration compiles the Rust dev profile, so `debug_assertions`
/// tracks the flavor exactly.
#[cfg(all(target_os = "ios", debug_assertions))]
const SHARED_GROUP_ID: &str = "group.app.reflect.dev";
#[cfg(all(target_os = "ios", not(debug_assertions)))]
const SHARED_GROUP_ID: &str = "group.app.reflect";

/// The envelope spool directory inside the App Group container. The extension
/// creates it lazily; a missing directory relays as zero.
#[cfg(any(target_os = "ios", test))]
const SHARED_INBOX_DIR: &str = "inbox";

/// Where oversized shared spools are quarantined, beside the shared inbox —
/// moved, never deleted, mirroring the drain's `.reflect/inbox-rejected/`.
const SHARED_REJECTED_DIR: &str = "inbox-rejected";

/// A `.json.tmp` older than this is debris from an extension crash between
/// its write and its commit rename — swept so the container can't accrete
/// junk (the drain applies the same rule to orphan screenshots).
const SHARED_TMP_MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// Move every spooled `.json` envelope from the shared inbox into the graph's
/// capture inbox. Copy + atomic write + delete-source, because the App Group
/// container and the graph root (app sandbox or iCloud container) are
/// different volumes where a rename cannot cross. A crash between the copy
/// and the source delete re-relays the same envelope later — the drain's
/// deterministic identity makes that idempotent. Bytes only: unparseable
/// envelopes still relay, and the drain quarantines them with the rest.
fn relay_shared_spools(shared_inbox: &Path, root: &Path) -> AppResult<u32> {
    let entries = match fs::read_dir(shared_inbox) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(err.into()),
    };
    let mut relayed = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = entry.metadata()?;
        // Extension tmp files (`<id>.json.tmp`) and hidden files are not
        // spool entries; only committed `.json` envelopes relay. Old tmp
        // files are crash debris (write happened, commit rename didn't) —
        // swept; the age guard covers an extension writing right now.
        if !metadata.is_file() || name.starts_with('.') || !name.ends_with(".json") {
            if metadata.is_file()
                && name.ends_with(".json.tmp")
                && metadata
                    .modified()
                    .ok()
                    .and_then(|at| at.elapsed().ok())
                    .is_some_and(|age| age > SHARED_TMP_MAX_AGE)
            {
                fs::remove_file(entry.path())?;
            }
            continue;
        }
        let Ok(target) = inbox_file(root, &name) else {
            continue; // not a spool filename this app would ever address
        };
        if metadata.len() > INBOX_SPOOL_MAX_BYTES as u64 {
            // Anything near the cap is not a capture. Quarantined beside the
            // shared inbox so it can't wedge the relay forever.
            let rejected = shared_inbox
                .parent()
                .ok_or_else(|| AppError::io("shared inbox has no parent directory"))?
                .join(SHARED_REJECTED_DIR);
            fs::create_dir_all(&rejected)?;
            fs::rename(entry.path(), rejected.join(&name))?;
            continue;
        }
        let bytes = fs::read(entry.path())?;
        atomic_write_bytes_to(&target, &bytes)?;
        fs::remove_file(entry.path())?;
        relayed += 1;
    }
    Ok(relayed)
}

/// The shared inbox the iOS share extension writes: `<App Group>/inbox`.
/// `None` when the container is unavailable (non-iOS platforms; a build
/// without the App Group entitlement).
#[cfg(target_os = "ios")]
fn shared_inbox_dir() -> Option<PathBuf> {
    use objc2_foundation::{NSFileManager, NSString};
    let manager = NSFileManager::defaultManager();
    let group = NSString::from_str(SHARED_GROUP_ID);
    let container = manager.containerURLForSecurityApplicationGroupIdentifier(&group)?;
    let path = container.path()?.to_string();
    Some(PathBuf::from(path).join(SHARED_INBOX_DIR))
}

/// Only iOS has a share-extension producer; every other platform's capture
/// producers write the graph inbox directly.
#[cfg(not(target_os = "ios"))]
fn shared_inbox_dir() -> Option<PathBuf> {
    None
}

/// Relay envelopes the iOS share extension spooled into the App Group inbox
/// into the open graph's capture inbox, where the normal drain materializes
/// them. Returns how many envelopes moved; zero without a shared container.
/// Called by the mobile capture controller on launch and every foreground.
#[tauri::command]
pub fn capture_shared_inbox_relay(generation: u64, state: State<GraphState>) -> AppResult<u32> {
    let root = root_for_generation(&state, generation)?;
    match shared_inbox_dir() {
        Some(shared) => relay_shared_spools(&shared, &root),
        None => Ok(0),
    }
}

// ---- screenshot promote ---------------------------------------------------------

/// Decode, downscale to `max_dim` on the long edge, re-encode as JPEG. Pure —
/// the unit tests exercise this without Tauri state.
fn downscale_jpeg(bytes: &[u8], max_dim: u32) -> AppResult<Vec<u8>> {
    let decoded = image::load_from_memory(bytes)
        .map_err(|err| AppError::parse(format!("screenshot does not decode: {err}")))?;
    let resized = if decoded.width() > max_dim || decoded.height() > max_dim {
        decoded.resize(max_dim, max_dim, image::imageops::FilterType::CatmullRom)
    } else {
        decoded
    };
    let mut out = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    resized
        .into_rgb8() // JPEG carries no alpha; screenshots are opaque
        .write_with_encoder(encoder)
        .map_err(|err| AppError::io(format!("screenshot re-encode failed: {err}")))?;
    Ok(out)
}

/// Copy a spooled screenshot into the graph as a downscaled JPEG asset. Copy,
/// not move — the drain removes spool files only after the note is written,
/// so a crash mid-drain re-runs cleanly.
#[tauri::command]
pub fn capture_screenshot_promote(
    spool_name: String,
    asset_path: String,
    max_dim: u32,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    let root = root_for_generation(&state, generation)?;
    let bytes = fs::read(inbox_file(&root, &spool_name)?)?;
    let jpeg = downscale_jpeg(&bytes, max_dim)?;
    let target = crate::fs::resolve_in_graph(&root, &asset_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = tempfile::NamedTempFile::new_in(
        target
            .parent()
            .ok_or_else(|| AppError::io("asset path has no parent"))?,
    )?;
    tmp.write_all(&jpeg)?;
    tmp.flush()?;
    tmp.persist(&target)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

// ---- meta fetch -----------------------------------------------------------------

/// How much HTML the meta scrape reads: `<head>` metadata lives well inside
/// the first half-megabyte of any real page.
const META_FETCH_MAX_BYTES: usize = 512 * 1024;
const META_FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// The meta fetch presents as a mainstream browser navigation: sites that
/// gate on client fingerprint (Instagram among them) can answer bare app
/// user agents with login walls or challenges a normal browser request never
/// sees. Safari's platform token is frozen upstream, so the string stays
/// plausible without tracking macOS releases.
const META_FETCH_USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ",
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
);

fn classify_fetch_error(err: reqwest::Error) -> AppError {
    if err.is_timeout() || err.is_connect() || err.is_request() {
        AppError::Network {
            message: err.to_string(),
        }
    } else {
        AppError::io(err.to_string())
    }
}

/// Map a meta-fetch response status to its error: `None` for success,
/// retryable `Network` for server errors and rate limiting (sites like
/// Instagram answer `429` to bursts and recover — the enrichment pass keeps
/// the capture pending and tries again later), permanent `io` for everything
/// else.
fn classify_fetch_status(url: &str, status: reqwest::StatusCode) -> Option<AppError> {
    if status.is_success() {
        return None;
    }
    let message = format!("{url} answered {status}");
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Some(AppError::Network { message });
    }
    Some(AppError::io(message))
}

/// Fetch a captured page's HTML for meta-tag scraping, hard-capped (timeout,
/// byte cap, redirect limit, http(s) only). Lives here rather than widening
/// the webview's HTTP-plugin capability to every URL — the only thing that
/// can reach arbitrary hosts is this bounded, HTML-only primitive, and the
/// privacy gate in `@reflect/core` runs before it is ever called.
#[tauri::command]
pub async fn capture_meta_fetch(url: String) -> AppResult<String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(AppError::parse(format!("not an http(s) url: {url}")));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(META_FETCH_TIMEOUT)
        .user_agent(META_FETCH_USER_AGENT)
        .build()
        .map_err(|err| AppError::io(err.to_string()))?;
    let response = client
        .get(&url)
        // The full header set a browser sends on a typed-URL navigation —
        // absent Sec-Fetch/Accept-Language headers are themselves a bot
        // signal to fingerprinting CDNs.
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .header("Upgrade-Insecure-Requests", "1")
        .send()
        .await
        .map_err(classify_fetch_error)?;

    if let Some(err) = classify_fetch_status(&url, response.status()) {
        return Err(err);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase(); // MIME types are case-insensitive (`TEXT/HTML`)
    if !content_type.contains("html") {
        return Err(AppError::parse(format!(
            "{url} is not an HTML page ({content_type})"
        )));
    }

    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(classify_fetch_error)? {
        let remaining = META_FETCH_MAX_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() >= META_FETCH_MAX_BYTES {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_fetch_statuses_classify_rate_limits_as_retryable() {
        use reqwest::StatusCode;
        let url = "https://www.instagram.com/reel/example/";
        assert!(classify_fetch_status(url, StatusCode::OK).is_none());
        assert!(matches!(
            classify_fetch_status(url, StatusCode::TOO_MANY_REQUESTS),
            Some(AppError::Network { .. })
        ));
        assert!(matches!(
            classify_fetch_status(url, StatusCode::BAD_GATEWAY),
            Some(AppError::Network { .. })
        ));
        assert!(matches!(
            classify_fetch_status(url, StatusCode::NOT_FOUND),
            Some(AppError::Io { .. })
        ));
        assert!(matches!(
            classify_fetch_status(url, StatusCode::FORBIDDEN),
            Some(AppError::Io { .. })
        ));
    }

    #[test]
    fn manifest_pins_name_path_and_origins() {
        let manifest = host_manifest_json(Path::new(
            "/Applications/Reflect.app/Contents/MacOS/reflect-capture-host",
        ));
        let parsed: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(parsed["name"], "app.reflect.capture");
        assert_eq!(parsed["type"], "stdio");
        assert_eq!(
            parsed["path"],
            "/Applications/Reflect.app/Contents/MacOS/reflect-capture-host"
        );
        assert_eq!(
            parsed["allowed_origins"],
            serde_json::json!([
                "chrome-extension://dlbliojklpickgimjdmjjdnbjdiomjik/",
                "chrome-extension://ccabifmooehighoonjeiololjfofkhkd/"
            ])
        );
    }

    #[test]
    fn detects_only_installed_browsers() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Google/Chrome")).unwrap();
        fs::create_dir_all(dir.path().join("Arc/User Data")).unwrap();
        // Vivaldi absent.
        let dirs = detected_manifest_dirs(dir.path());
        assert_eq!(
            dirs,
            vec![
                dir.path().join("Google/Chrome/NativeMessagingHosts"),
                dir.path().join("Arc/User Data/NativeMessagingHosts"),
            ]
        );
    }

    #[test]
    fn register_writes_a_manifest_per_detected_browser() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Google/Chrome")).unwrap();
        let written =
            register_manifests(dir.path(), Path::new("/bundle/reflect-capture-host")).unwrap();
        assert_eq!(written, 1);
        let manifest = dir
            .path()
            .join("Google/Chrome/NativeMessagingHosts/app.reflect.capture.json");
        assert!(manifest.is_file());
    }

    #[test]
    fn pointer_json_is_versioned() {
        let parsed: serde_json::Value =
            serde_json::from_str(&pointer_json(Path::new("/graphs/personal"))).unwrap();
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["graphRoot"], "/graphs/personal");
    }

    #[test]
    fn spool_size_cap_refuses_oversized_envelopes() {
        assert!(ensure_spool_size("{\"small\":true}").is_ok());
        assert!(matches!(
            ensure_spool_size(&"x".repeat(INBOX_SPOOL_MAX_BYTES + 1)),
            Err(AppError::Parse { .. })
        ));
    }

    #[test]
    fn inbox_file_refuses_traversal_shaped_names() {
        let root = Path::new("/g");
        for name in ["../escape.json", "a/b.json", ".hidden", "..\\win.json"] {
            assert!(inbox_file(root, name).is_err(), "{name}");
        }
        assert!(inbox_file(root, "7c9e6679.json").is_ok());
    }

    #[test]
    fn quarantine_moves_the_spool_file_out_of_the_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join(INBOX_DIR);
        fs::create_dir_all(&inbox).unwrap();
        fs::write(inbox.join("bad.json"), "not an envelope").unwrap();

        quarantine_spool(dir.path(), "bad.json").unwrap();

        assert!(!inbox.join("bad.json").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join(INBOX_REJECTED_DIR).join("bad.json")).unwrap(),
            "not an envelope"
        );
    }

    #[test]
    fn quarantine_is_idempotent_for_a_missing_source() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(INBOX_DIR)).unwrap();
        assert!(quarantine_spool(dir.path(), "gone.json").is_ok());
    }

    #[test]
    fn relay_moves_committed_envelopes_into_the_graph_inbox() {
        let shared = tempfile::tempdir().unwrap();
        let graph = tempfile::tempdir().unwrap();
        let shared_inbox = shared.path().join(SHARED_INBOX_DIR);
        fs::create_dir_all(&shared_inbox).unwrap();
        fs::write(shared_inbox.join("7c9e6679.json"), r#"{"version":1}"#).unwrap();
        fs::write(shared_inbox.join("aabbccdd.json"), r#"{"version":1}"#).unwrap();
        // Not spool entries: a fresh mid-write tmp file and a hidden file.
        fs::write(shared_inbox.join("eeff0011.json.tmp"), "partial").unwrap();
        fs::write(shared_inbox.join(".DS_Store"), "junk").unwrap();

        let relayed = relay_shared_spools(&shared_inbox, graph.path()).unwrap();

        assert_eq!(relayed, 2);
        let inbox = graph.path().join(INBOX_DIR);
        assert_eq!(
            fs::read_to_string(inbox.join("7c9e6679.json")).unwrap(),
            r#"{"version":1}"#
        );
        assert!(inbox.join("aabbccdd.json").is_file());
        assert!(!shared_inbox.join("7c9e6679.json").exists());
        assert!(!shared_inbox.join("aabbccdd.json").exists());
        assert!(shared_inbox.join("eeff0011.json.tmp").exists());
        assert!(shared_inbox.join(".DS_Store").exists());
    }

    #[test]
    fn relay_sweeps_old_tmp_debris_but_never_young_tmp_files() {
        let shared = tempfile::tempdir().unwrap();
        let graph = tempfile::tempdir().unwrap();
        let shared_inbox = shared.path().join(SHARED_INBOX_DIR);
        fs::create_dir_all(&shared_inbox).unwrap();
        let old = shared_inbox.join("dead.json.tmp");
        let young = shared_inbox.join("live.json.tmp");
        fs::write(&old, "crash debris").unwrap();
        fs::write(&young, "being written").unwrap();
        let file = fs::File::options().write(true).open(&old).unwrap();
        let stale = std::time::SystemTime::now() - (SHARED_TMP_MAX_AGE + Duration::from_secs(60));
        file.set_times(fs::FileTimes::new().set_modified(stale))
            .unwrap();

        let relayed = relay_shared_spools(&shared_inbox, graph.path()).unwrap();

        assert_eq!(relayed, 0);
        assert!(!old.exists());
        assert!(young.exists());
    }

    #[test]
    fn relay_of_a_missing_shared_inbox_is_zero() {
        let graph = tempfile::tempdir().unwrap();
        let relayed =
            relay_shared_spools(Path::new("/nonexistent/shared/inbox"), graph.path()).unwrap();
        assert_eq!(relayed, 0);
    }

    #[test]
    fn relay_overwrites_a_crash_duplicate_instead_of_failing() {
        let shared = tempfile::tempdir().unwrap();
        let graph = tempfile::tempdir().unwrap();
        let shared_inbox = shared.path().join(SHARED_INBOX_DIR);
        fs::create_dir_all(&shared_inbox).unwrap();
        let inbox = graph.path().join(INBOX_DIR);
        fs::create_dir_all(&inbox).unwrap();
        // A crash between the copy and the source delete leaves both sides.
        fs::write(shared_inbox.join("7c9e6679.json"), r#"{"version":1}"#).unwrap();
        fs::write(inbox.join("7c9e6679.json"), r#"{"version":1}"#).unwrap();

        let relayed = relay_shared_spools(&shared_inbox, graph.path()).unwrap();

        assert_eq!(relayed, 1);
        assert!(!shared_inbox.join("7c9e6679.json").exists());
        assert!(inbox.join("7c9e6679.json").is_file());
    }

    #[test]
    fn relay_quarantines_oversized_spools_beside_the_shared_inbox() {
        let shared = tempfile::tempdir().unwrap();
        let graph = tempfile::tempdir().unwrap();
        let shared_inbox = shared.path().join(SHARED_INBOX_DIR);
        fs::create_dir_all(&shared_inbox).unwrap();
        fs::write(
            shared_inbox.join("big.json"),
            "x".repeat(INBOX_SPOOL_MAX_BYTES + 1),
        )
        .unwrap();

        let relayed = relay_shared_spools(&shared_inbox, graph.path()).unwrap();

        assert_eq!(relayed, 0);
        assert!(!shared_inbox.join("big.json").exists());
        assert!(shared
            .path()
            .join(SHARED_REJECTED_DIR)
            .join("big.json")
            .is_file());
        assert!(!graph.path().join(INBOX_DIR).join("big.json").exists());
    }

    #[test]
    fn downscale_caps_the_long_edge_and_reencodes_jpeg() {
        let wide = image::DynamicImage::new_rgb8(3200, 1000);
        let mut png = Vec::new();
        wide.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let jpeg = downscale_jpeg(&png, 1600).unwrap();
        let decoded = image::load_from_memory(&jpeg).unwrap();
        assert_eq!(decoded.width(), 1600);
        assert_eq!(decoded.height(), 500);
    }

    #[test]
    fn downscale_leaves_small_images_unscaled() {
        let small = image::DynamicImage::new_rgb8(800, 600);
        let mut png = Vec::new();
        small
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let decoded = image::load_from_memory(&downscale_jpeg(&png, 1600).unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (800, 600));
    }

    #[test]
    fn downscale_rejects_non_images() {
        assert!(matches!(
            downscale_jpeg(b"not an image", 1600),
            Err(AppError::Parse { .. })
        ));
    }
}
