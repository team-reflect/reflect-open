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

/// Write asset bytes into the graph atomically: a same-directory temp file
/// first, then a rename — readers never see a half-written asset.
fn persist_asset(root: &std::path::Path, asset_path: &str, bytes: &[u8]) -> AppResult<()> {
    let target = crate::fs::resolve_in_graph(root, asset_path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = tempfile::NamedTempFile::new_in(
        target
            .parent()
            .ok_or_else(|| AppError::io("asset path has no parent"))?,
    )?;
    tmp.write_all(bytes)?;
    tmp.flush()?;
    tmp.persist(&target)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
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
    persist_asset(&root, &asset_path, &jpeg)
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

/// What the meta fetch hands back: the capped HTML plus the URL that
/// actually served it — redirects are followed, so relative references in
/// the HTML (an `og:image` path) must resolve against `final_url`, not the
/// URL the capture started from.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaFetchResponse {
    pub html: String,
    pub final_url: String,
}

/// Fetch a captured page's HTML for meta-tag scraping, hard-capped (timeout,
/// byte cap, redirect limit, http(s) only). Lives here rather than widening
/// the webview's HTTP-plugin capability to every URL — the only thing that
/// can reach arbitrary hosts is this bounded, HTML-only primitive, and the
/// privacy gate in `@reflect/core` runs before it is ever called.
///
/// Deliberately *not* host-vetted the way `capture_image_fetch` is: the
/// capture URL is one the user chose to share (user intent, possibly a
/// private-network page they legitimately want captured), whereas the image
/// URL comes from page content. The response is only ever parsed for text
/// metadata. Revisit if scrape targets ever become content-controlled.
#[tauri::command]
pub async fn capture_meta_fetch(url: String) -> AppResult<MetaFetchResponse> {
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

    let final_url = response.url().to_string();
    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(classify_fetch_error)? {
        let remaining = META_FETCH_MAX_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() >= META_FETCH_MAX_BYTES {
            break;
        }
    }
    Ok(MetaFetchResponse {
        html: String::from_utf8_lossy(&body).into_owned(),
        final_url,
    })
}

/// Cap on a fetched preview image's raw bytes. Unlike the HTML fetch, a
/// truncated image is useless, so an oversized answer fails instead of
/// being cut off; the downscale pass below bounds what lands in the graph.
const IMAGE_FETCH_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Is this Content-Type an image? Parameters (`; charset=…`) don't matter;
/// case doesn't either (the caller lowercases).
fn image_content_type(content_type: &str) -> bool {
    content_type.trim_start().starts_with("image/")
}

/// Is this an address the preview-image fetch may connect to? The image URL
/// comes from page *content* — attacker-controlled, unlike the user-shared
/// capture URL — so the fetch must never become a bridge onto localhost, the
/// user's LAN, carrier-grade NAT space, or link-local metadata endpoints.
fn public_address(addr: &std::net::IpAddr) -> bool {
    match addr {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            let cgnat = octets[0] == 100 && (octets[1] & 0xc0) == 64; // 100.64/10
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                || cgnat)
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return public_address(&std::net::IpAddr::V4(mapped));
            }
            let segments = v6.segments();
            let unique_local = (segments[0] & 0xfe00) == 0xfc00; // fc00::/7
            let link_local = (segments[0] & 0xffc0) == 0xfe80; // fe80::/10
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || unique_local
                || link_local)
        }
    }
}

/// Which hosts the preview-image fetch may connect to. Production always
/// runs [`HostPolicy::PublicOnly`]; the test-only variant lets integration
/// tests point the fetch at a loopback server to exercise the redirect,
/// content-type, and byte-cap mechanics.
#[derive(Clone, Copy)]
enum HostPolicy {
    /// Every hop's host must resolve exclusively to public addresses.
    PublicOnly,
    /// Skip the public-address check (local test servers only).
    #[cfg(test)]
    AllowLocal,
}

/// Resolve one redirect hop's host and refuse it unless every address is
/// public ([`public_address`]); returns the full vetted address list so the
/// caller can pin the connection to it — all of it, keeping the resolver's
/// v4/v6 fallback — because resolving again at connect time would reopen
/// the DNS-rebinding window this check closes.
async fn vetted_image_addrs(
    target: &reqwest::Url,
    hosts: HostPolicy,
) -> AppResult<Vec<std::net::SocketAddr>> {
    let host = target
        .host_str()
        .ok_or_else(|| AppError::parse(format!("{target} has no host")))?;
    let port = target
        .port_or_known_default()
        .ok_or_else(|| AppError::parse(format!("{target} has no port")))?;
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|err| AppError::Network {
            message: format!("{host} did not resolve: {err}"),
        })?
        .collect();
    if addrs.is_empty() {
        return Err(AppError::Network {
            message: format!("{host} did not resolve"),
        });
    }
    match hosts {
        #[cfg(test)]
        HostPolicy::AllowLocal => return Ok(addrs),
        HostPolicy::PublicOnly => {}
    }
    for addr in &addrs {
        if !public_address(&addr.ip()) {
            return Err(AppError::parse(format!(
                "{host} resolves to a non-public address"
            )));
        }
    }
    Ok(addrs)
}

/// The network half of the preview-image fetch: follow redirects manually
/// (host-vetted per hop, connection pinned to the vetted addresses), require
/// image content, cap the raw bytes, and downscale/re-encode to JPEG.
/// Stateless so the integration tests can exercise it against a local
/// server; the command below owns graph-root resolution and the write.
async fn fetch_preview_image(url: &str, max_dim: u32, hosts: HostPolicy) -> AppResult<Vec<u8>> {
    let mut target =
        reqwest::Url::parse(url).map_err(|err| AppError::parse(format!("{url}: {err}")))?;
    let mut response: Option<reqwest::Response> = None;
    for _hop in 0..=5 {
        if target.scheme() != "https" && target.scheme() != "http" {
            return Err(AppError::parse(format!("not an http(s) url: {target}")));
        }
        let addrs = vetted_image_addrs(&target, hosts).await?;
        let host = target.host_str().unwrap_or_default().to_owned();
        // Redirects are followed manually (with the host re-vetted each hop)
        // and the connection pinned to the vetted addresses.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &addrs)
            .timeout(META_FETCH_TIMEOUT)
            .user_agent(META_FETCH_USER_AGENT)
            .build()
            .map_err(|err| AppError::io(err.to_string()))?;
        let hop_response = client
            .get(target.clone())
            // What a browser sends when a page loads a cross-site image.
            .header(
                "Accept",
                "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5",
            )
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Sec-Fetch-Dest", "image")
            .header("Sec-Fetch-Mode", "no-cors")
            .header("Sec-Fetch-Site", "cross-site")
            .send()
            .await
            .map_err(classify_fetch_error)?;
        if hop_response.status().is_redirection() {
            let location = hop_response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::io(format!("{target} redirected without a location")))?;
            target = target
                .join(location)
                .map_err(|err| AppError::parse(format!("{target} redirected badly: {err}")))?;
            continue;
        }
        response = Some(hop_response);
        break;
    }
    let response =
        response.ok_or_else(|| AppError::io(format!("{url} redirected too many times")))?;

    if let Some(err) = classify_fetch_status(url, response.status()) {
        return Err(err);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !image_content_type(&content_type) {
        return Err(AppError::parse(format!(
            "{url} is not an image ({content_type})"
        )));
    }

    let mut bytes: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(classify_fetch_error)? {
        if bytes.len() + chunk.len() > IMAGE_FETCH_MAX_BYTES {
            return Err(AppError::io(format!("{url} exceeds the preview image cap")));
        }
        bytes.extend_from_slice(&chunk);
    }
    downscale_jpeg(&bytes, max_dim)
}

/// Fetch a captured page's own preview image (its `og:image`) and store it
/// as the capture's screenshot asset. Same bounded shape as the meta fetch —
/// http(s) only, timeout, redirect limit, byte cap, browser presentation —
/// plus image-only content, public-address-only hosts (checked per redirect
/// hop, connections pinned to the vetted address), and the screenshot
/// downscale/re-encode, so a hostile URL can neither widen the webview's
/// HTTP capability, reach into the local network, nor land oversized or
/// non-image bytes in the graph. The privacy gate in `@reflect/core` runs
/// before it is ever called.
#[tauri::command]
pub async fn capture_image_fetch(
    url: String,
    asset_path: String,
    max_dim: u32,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<()> {
    // Fail fast before any network work; the root is re-derived after it.
    root_for_generation(&state, generation)?;
    let jpeg = fetch_preview_image(&url, max_dim, HostPolicy::PublicOnly).await?;
    // Re-pin the graph: a 15s fetch is long enough for a graph switch, and
    // persisting into a stale root would resurrect files under it.
    let root = root_for_generation(&state, generation)?;
    persist_asset(&root, &asset_path, &jpeg)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serve canned HTTP/1.1 responses on 127.0.0.1: each connection's
    /// request path is matched against `routes` and the canned bytes written
    /// back verbatim. Returns the server's base URL.
    async fn serve(routes: Vec<(&'static str, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let routes = Arc::new(routes);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let Ok(read) = stream.read(&mut buf).await else {
                        return;
                    };
                    let head = String::from_utf8_lossy(&buf[..read]).into_owned();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let not_found = response("404 Not Found", &[], b"");
                    let body = routes
                        .iter()
                        .find(|(route, _)| *route == path)
                        .map(|(_, bytes)| bytes.as_slice())
                        .unwrap_or(&not_found);
                    let _ = stream.write_all(body).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        base
    }

    /// One canned HTTP/1.1 response with correct framing.
    fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {status}\r\n");
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        ));
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    /// A tiny valid PNG for the happy-path fetch.
    fn png_bytes() -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 4)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn error_message(result: AppResult<Vec<u8>>) -> String {
        match result.unwrap_err() {
            AppError::Io { message }
            | AppError::Parse { message }
            | AppError::Network { message } => message,
            other => panic!("unexpected error kind: {other:?}"),
        }
    }

    #[tokio::test]
    async fn preview_fetch_follows_relative_redirects_to_the_image() {
        let base = serve(vec![
            (
                "/start",
                response("302 Found", &[("Location", "/hop/")], b""),
            ),
            // A relative Location must resolve against the current hop.
            (
                "/hop/",
                response("302 Found", &[("Location", "cover.png")], b""),
            ),
            (
                "/hop/cover.png",
                response("200 OK", &[("Content-Type", "image/png")], &png_bytes()),
            ),
        ])
        .await;

        let jpeg = fetch_preview_image(&format!("{base}/start"), 64, HostPolicy::AllowLocal)
            .await
            .unwrap();

        // Decoded and re-encoded: the stored asset is JPEG regardless of source.
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    }

    #[tokio::test]
    async fn preview_fetch_gives_up_after_five_redirects() {
        let base = serve(vec![(
            "/loop",
            response("302 Found", &[("Location", "/loop")], b""),
        )])
        .await;

        let message = error_message(
            fetch_preview_image(&format!("{base}/loop"), 64, HostPolicy::AllowLocal).await,
        );

        assert!(message.contains("redirected too many times"), "{message}");
    }

    #[tokio::test]
    async fn preview_fetch_fails_on_a_redirect_without_a_location() {
        let base = serve(vec![("/lost", response("302 Found", &[], b""))]).await;

        let message = error_message(
            fetch_preview_image(&format!("{base}/lost"), 64, HostPolicy::AllowLocal).await,
        );

        assert!(
            message.contains("redirected without a location"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn preview_fetch_refuses_non_image_content() {
        let base = serve(vec![(
            "/page",
            response("200 OK", &[("Content-Type", "text/html")], b"<html></html>"),
        )])
        .await;

        let message = error_message(
            fetch_preview_image(&format!("{base}/page"), 64, HostPolicy::AllowLocal).await,
        );

        assert!(message.contains("is not an image"), "{message}");
    }

    #[tokio::test]
    async fn preview_fetch_refuses_oversized_images() {
        let oversized = vec![0u8; IMAGE_FETCH_MAX_BYTES + 1];
        let base = serve(vec![(
            "/huge.png",
            response("200 OK", &[("Content-Type", "image/png")], &oversized),
        )])
        .await;

        let message = error_message(
            fetch_preview_image(&format!("{base}/huge.png"), 64, HostPolicy::AllowLocal).await,
        );

        assert!(
            message.contains("exceeds the preview image cap"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn preview_fetch_refuses_local_hosts_in_production_policy() {
        // The SSRF regression test: under the production policy the fetch
        // must refuse loopback before a single byte is sent.
        let base = serve(vec![(
            "/cover.png",
            response("200 OK", &[("Content-Type", "image/png")], &png_bytes()),
        )])
        .await;

        let message = error_message(
            fetch_preview_image(&format!("{base}/cover.png"), 64, HostPolicy::PublicOnly).await,
        );

        assert!(message.contains("non-public address"), "{message}");
    }

    #[tokio::test]
    async fn meta_fetch_truncates_at_the_byte_cap() {
        let mut html = String::from("<html><head><title>Big page</title></head><body>");
        html.push_str(&"x".repeat(600 * 1024));
        let base = serve(vec![(
            "/page",
            response("200 OK", &[("Content-Type", "text/html")], html.as_bytes()),
        )])
        .await;

        let fetched = capture_meta_fetch(format!("{base}/page")).await.unwrap();

        assert_eq!(fetched.html.len(), META_FETCH_MAX_BYTES);
        assert!(fetched.html.contains("<title>Big page</title>"));
        assert_eq!(fetched.final_url, format!("{base}/page"));
    }

    #[tokio::test]
    async fn meta_fetch_reports_the_redirected_final_url() {
        let base = serve(vec![
            (
                "/moved",
                response("301 Moved Permanently", &[("Location", "/final/page")], b""),
            ),
            (
                "/final/page",
                response(
                    "200 OK",
                    &[("Content-Type", "text/html")],
                    b"<html><head><title>Landed</title></head></html>",
                ),
            ),
        ])
        .await;

        let fetched = capture_meta_fetch(format!("{base}/moved")).await.unwrap();

        // Relative references in the HTML must resolve against this URL.
        assert_eq!(fetched.final_url, format!("{base}/final/page"));
        assert!(fetched.html.contains("Landed"));
    }

    #[tokio::test]
    async fn meta_fetch_refuses_non_html_content() {
        let base = serve(vec![(
            "/cover.png",
            response("200 OK", &[("Content-Type", "image/png")], &png_bytes()),
        )])
        .await;

        let result = capture_meta_fetch(format!("{base}/cover.png")).await;

        assert!(matches!(result, Err(AppError::Parse { .. })), "{result:?}");
    }

    #[test]
    fn public_addresses_exclude_every_local_network_family() {
        use std::net::IpAddr;
        let public = |candidate: &str| public_address(&candidate.parse::<IpAddr>().unwrap());
        assert!(public("93.184.216.34"));
        assert!(public("2606:2800:220:1:248:1893:25c8:1946"));
        assert!(!public("127.0.0.1")); // loopback
        assert!(!public("10.0.0.8")); // private
        assert!(!public("172.16.4.1")); // private
        assert!(!public("192.168.1.1")); // private
        assert!(!public("169.254.169.254")); // link-local (cloud metadata)
        assert!(!public("100.64.0.1")); // carrier-grade NAT
        assert!(!public("0.0.0.0")); // unspecified
        assert!(!public("::1")); // v6 loopback
        assert!(!public("fd12:3456:789a::1")); // v6 unique-local
        assert!(!public("fe80::1")); // v6 link-local
        assert!(!public("::ffff:192.168.1.1")); // v4-mapped private
    }

    #[test]
    fn image_content_types_gate_on_the_image_family() {
        assert!(image_content_type("image/jpeg"));
        assert!(image_content_type("image/webp; charset=binary"));
        assert!(!image_content_type("text/html"));
        assert!(!image_content_type("application/octet-stream"));
        assert!(!image_content_type(""));
    }

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
