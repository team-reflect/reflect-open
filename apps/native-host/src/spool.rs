//! Inbox discovery and atomic spool writes. The desktop app maintains the
//! pointer file (`<config_dir>/reflect-open/capture-pointer.json`, rewritten
//! on every launch and graph switch); the host only ever reads it. Spool
//! writes are Maildir-discipline: tmp file + rename, screenshot first, the
//! `.json` envelope last — the `.json` is the commit point the desktop
//! watcher and drain key on, and tmp names never end in `.json` so a
//! half-written capture can never look committed.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::envelope::ValidatedCapture;
use crate::HostError;

/// The pointer-file shape the desktop app writes. Versioned so a future
/// layout change reads as a typed error here, never as a silent mis-spool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pointer {
    version: u32,
    graph_root: String,
}

/// Default pointer-file location, shared with the desktop app's conventions
/// (`settings.rs`/`recents.rs` live in the same directory).
pub fn default_pointer_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("reflect-open")
            .join("capture-pointer.json"),
    )
}

/// Resolve the capture inbox from the pointer file, creating the inbox
/// directory if missing. A missing pointer is the `no-graph` state.
pub fn inbox_dir(pointer_path: &Path) -> Result<PathBuf, HostError> {
    let raw = match std::fs::read(pointer_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(HostError::NoGraph)
        }
        Err(error) => return Err(HostError::Io(format!("pointer file unreadable: {error}"))),
    };
    let pointer: Pointer = serde_json::from_slice(&raw)
        .map_err(|error| HostError::Io(format!("pointer file malformed: {error}")))?;
    if pointer.version != 1 {
        return Err(HostError::Io(format!(
            "pointer file version {} is not supported",
            pointer.version
        )));
    }
    let root = PathBuf::from(pointer.graph_root);
    if !root.is_dir() {
        return Err(HostError::NoGraph);
    }
    let inbox = root.join(".reflect").join("inbox");
    std::fs::create_dir_all(&inbox)
        .map_err(|error| HostError::Io(format!("cannot create inbox: {error}")))?;
    Ok(inbox)
}

/// Tmp-then-rename write. The tmp name (`.tmp-…`) can never match the
/// watcher's `*.json` filter, so renames are the only visible events.
fn atomic_write(directory: &Path, filename: &str, bytes: &[u8]) -> Result<(), HostError> {
    let io_error = |error: std::io::Error| HostError::Io(format!("spool write failed: {error}"));
    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-")
        .tempfile_in(directory)
        .map_err(io_error)?;
    tmp.write_all(bytes).map_err(io_error)?;
    tmp.flush().map_err(io_error)?;
    tmp.persist(directory.join(filename))
        .map_err(|error| HostError::Io(format!("spool rename failed: {}", error.error)))?;
    Ok(())
}

/// Spool one validated capture: `<id>.jpg` first (when present), then the
/// `<id>.json` envelope as the commit point.
pub fn spool_capture(inbox: &Path, capture: &ValidatedCapture) -> Result<(), HostError> {
    if let Some(screenshot) = &capture.screenshot {
        atomic_write(inbox, &format!("{}.jpg", capture.envelope.id), screenshot)?;
    }
    let envelope_json = serde_json::to_vec(&capture.envelope)
        .map_err(|error| HostError::Io(format!("envelope serialization failed: {error}")))?;
    atomic_write(
        inbox,
        &format!("{}.json", capture.envelope.id),
        &envelope_json,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(screenshot: Option<&[u8]>) -> ValidatedCapture {
        let with_screenshot = screenshot.is_some();
        let payload = serde_json::json!({
            "envelope": {
                "version": 1,
                "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
                "url": "https://example.com",
                "title": "Example",
                "capturedAt": "2026-06-12T15:30:22.845Z",
                "source": "extension",
            },
            "screenshotBase64": screenshot.map(|bytes| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(bytes)
            }),
        });
        let parsed = ValidatedCapture::parse(payload.to_string().as_bytes()).unwrap();
        assert_eq!(parsed.screenshot.is_some(), with_screenshot);
        parsed
    }

    fn pointer_to(dir: &Path, graph: &Path) -> PathBuf {
        let pointer = dir.join("capture-pointer.json");
        std::fs::write(
            &pointer,
            serde_json::json!({ "version": 1, "graphRoot": graph.to_string_lossy() }).to_string(),
        )
        .unwrap();
        pointer
    }

    #[test]
    fn missing_pointer_is_no_graph() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            inbox_dir(&dir.path().join("nope.json")).unwrap_err(),
            HostError::NoGraph
        );
    }

    #[test]
    fn pointer_to_a_missing_graph_is_no_graph() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = pointer_to(dir.path(), &dir.path().join("gone-graph"));
        assert_eq!(inbox_dir(&pointer).unwrap_err(), HostError::NoGraph);
    }

    #[test]
    fn unsupported_pointer_version_is_a_typed_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = dir.path().join("capture-pointer.json");
        std::fs::write(&pointer, r#"{"version":99,"graphRoot":"/tmp"}"#).unwrap();
        assert!(matches!(inbox_dir(&pointer), Err(HostError::Io(_))));
    }

    #[test]
    fn creates_the_inbox_under_the_graph() {
        let dir = tempfile::tempdir().unwrap();
        let graph = dir.path().join("graph");
        std::fs::create_dir_all(&graph).unwrap();
        let pointer = pointer_to(dir.path(), &graph);

        let inbox = inbox_dir(&pointer).unwrap();
        assert_eq!(inbox, graph.join(".reflect/inbox"));
        assert!(inbox.is_dir());
    }

    #[test]
    fn spools_screenshot_then_envelope_with_no_tmp_residue() {
        let dir = tempfile::tempdir().unwrap();
        let parsed = capture(Some(b"jpeg-bytes"));
        spool_capture(dir.path(), &parsed).unwrap();

        let id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
        assert_eq!(
            std::fs::read(dir.path().join(format!("{id}.jpg"))).unwrap(),
            b"jpeg-bytes"
        );
        let envelope: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(format!("{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(envelope["screenshotRef"], format!("{id}.jpg"));

        let residue: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "tmp files left behind: {residue:?}");
    }

    #[test]
    fn spools_a_screenshot_free_capture_as_json_only() {
        let dir = tempfile::tempdir().unwrap();
        spool_capture(dir.path(), &capture(None)).unwrap();
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["7c9e6679-7425-40de-944b-e07fc1f90ae7.json"]);
    }
}
