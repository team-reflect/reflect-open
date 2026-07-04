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

fn atomic_write_to(path: &Path, contents: &str) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::io(format!("no parent directory for {}", path.display())))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents.as_bytes())?;
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

fn classify_fetch_error(err: reqwest::Error) -> AppError {
    if err.is_timeout() || err.is_connect() || err.is_request() {
        AppError::Network {
            message: err.to_string(),
        }
    } else {
        AppError::io(err.to_string())
    }
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
        .user_agent(concat!("Reflect/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| AppError::io(err.to_string()))?;
    let response = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(classify_fetch_error)?;

    let status = response.status();
    if status.is_server_error() {
        return Err(AppError::Network {
            message: format!("{url} answered {status}"),
        });
    }
    if !status.is_success() {
        return Err(AppError::io(format!("{url} answered {status}")));
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
