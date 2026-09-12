//! Versioned URL-only bookmark messages, spooled like every other capture.

use crate::{
    envelope::{is_iso_datetime, is_uuid},
    spool::{atomic_write, read_pointer},
    HostError,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MAX_BYTES: usize = 8192;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bookmark {
    pub version: u32,
    pub kind: String,
    pub id: String,
    pub source: String,
    pub post_id: String,
    pub captured_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    envelope: Bookmark,
}

impl Bookmark {
    pub fn parse(payload: &[u8]) -> Result<Self, HostError> {
        if payload.len() > MAX_BYTES {
            return Err(HostError::InvalidPayload(
                "Bookmark exceeds size limit".into(),
            ));
        }
        let wire: Wire = serde_json::from_slice(payload)
            .map_err(|_| HostError::InvalidPayload("Invalid bookmark message".into()))?;
        let bookmark = wire.envelope;
        if bookmark.version != 2 || bookmark.kind != "x-bookmark" {
            return Err(HostError::UnsupportedVersion);
        }
        if !is_uuid(&bookmark.id)
            || bookmark.source != "extension"
            || bookmark.post_id.is_empty()
            || bookmark.post_id.len() > 20
            || bookmark.post_id.starts_with('0')
            || !bookmark.post_id.bytes().all(|byte| byte.is_ascii_digit())
            || !is_iso_datetime(&bookmark.captured_at)
        {
            return Err(HostError::InvalidPayload("Invalid bookmark fields".into()));
        }
        Ok(bookmark)
    }
}

/// Spool into the pointed graph's inbox once the desktop advertises a v2 reader.
pub fn spool(payload: &[u8], pointer_path: &Path) -> Result<(), HostError> {
    let bookmark = Bookmark::parse(payload)?;
    let pointer = read_pointer(pointer_path)?;
    if pointer.bookmark_version != Some(2) {
        return Err(HostError::UnsupportedVersion);
    }
    let inbox = Path::new(&pointer.graph_root).join(".reflect/inbox");
    std::fs::create_dir_all(&inbox).map_err(|error| HostError::Io(error.to_string()))?;
    let bytes = serde_json::to_vec(&bookmark).map_err(|error| HostError::Io(error.to_string()))?;
    atomic_write(&inbox, &format!("{}.json", bookmark.id), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../packages/core/src/actions/bookmark-envelope.fixtures.json"
        ))
        .unwrap()
    }
    fn pointer(directory: &Path, bookmark_version: Option<u32>) -> std::path::PathBuf {
        let path = directory.join("pointer.json");
        let mut data = serde_json::json!({"version": 1, "graphRoot": directory});
        if let Some(version) = bookmark_version {
            data["bookmarkVersion"] = version.into();
        }
        std::fs::write(&path, data.to_string()).unwrap();
        path
    }
    #[test]
    fn shared_bookmark_boundary() {
        let values = fixtures();
        for value in values["accepted"].as_array().unwrap() {
            let bookmark = Bookmark::parse(value.to_string().as_bytes()).unwrap();
            let directory = tempfile::tempdir().unwrap();
            let pointer = pointer(directory.path(), Some(2));
            spool(value.to_string().as_bytes(), &pointer).unwrap();
            let actual: serde_json::Value = serde_json::from_slice(
                &std::fs::read(
                    directory
                        .path()
                        .join(format!(".reflect/inbox/{}.json", bookmark.id)),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(values["spooled"].as_array().unwrap().contains(&actual));
        }
        for value in values["rejected"].as_array().unwrap() {
            assert!(Bookmark::parse(value.to_string().as_bytes()).is_err());
        }
    }
    #[test]
    fn old_desktop_holds_bookmarks_and_replay_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let payload = fixtures()["accepted"][0].to_string();
        let old = pointer(directory.path(), None);
        assert_eq!(
            spool(payload.as_bytes(), &old).unwrap_err(),
            HostError::UnsupportedVersion
        );
        let current = pointer(directory.path(), Some(2));
        spool(payload.as_bytes(), &current).unwrap();
        spool(payload.as_bytes(), &current).unwrap();
        assert_eq!(
            std::fs::read_dir(directory.path().join(".reflect/inbox"))
                .unwrap()
                .count(),
            1
        );
    }
}
