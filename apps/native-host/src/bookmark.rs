//! Versioned URL-only bookmark messages and desktop capability negotiation.

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
    pub capture_date: String,
    pub target_graph_id: String,
    pub evidence: String,
    pub presentation: String,
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
            || bookmark.capture_date.len() != 10
            || !is_iso_datetime(&format!("{}T00:00:00Z", bookmark.capture_date))
            || bookmark.target_graph_id.len() != 64
            || !bookmark
                .target_graph_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !["manual", "request-intent"].contains(&bookmark.evidence.as_str())
            || !["link", "embed"].contains(&bookmark.presentation.as_str())
        {
            return Err(HostError::InvalidPayload("Invalid bookmark fields".into()));
        }
        Ok(bookmark)
    }
}

pub fn capabilities(pointer_path: &Path) -> Result<serde_json::Value, HostError> {
    let pointer = read_pointer(pointer_path)?;
    let target = pointer
        .target_graph_id
        .filter(|target| target.len() == 64)
        .filter(|_| pointer.bookmark_version == Some(2))
        .ok_or(HostError::UnsupportedVersion)?;
    Ok(
        serde_json::json!({"ok": true, "bookmarkVersion": 2, "targetGraphId": target, "maxMessageBytes": MAX_BYTES}),
    )
}

pub fn spool(payload: &[u8], pointer_path: &Path) -> Result<(), HostError> {
    let bookmark = Bookmark::parse(payload)?;
    let pointer = read_pointer(pointer_path)?;
    if pointer.bookmark_version != Some(2) {
        return Err(HostError::UnsupportedVersion);
    }
    if pointer.target_graph_id.as_deref() != Some(bookmark.target_graph_id.as_str()) {
        return Err(HostError::GraphMismatch);
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
    #[test]
    fn shared_bookmark_boundary() {
        let values = fixtures();
        for value in values["accepted"].as_array().unwrap() {
            assert!(Bookmark::parse(value.to_string().as_bytes()).is_ok());
        }
        for value in values["rejected"].as_array().unwrap() {
            assert!(Bookmark::parse(value.to_string().as_bytes()).is_err());
        }
    }
    #[test]
    fn old_desktop_cannot_advertise_bookmarks() {
        let directory = tempfile::tempdir().unwrap();
        let pointer = directory.path().join("pointer.json");
        std::fs::write(
            &pointer,
            serde_json::json!({"version":1,"graphRoot":directory.path()}).to_string(),
        )
        .unwrap();
        assert_eq!(
            capabilities(&pointer).unwrap_err(),
            HostError::UnsupportedVersion
        );
    }
    #[test]
    fn graph_binding_and_replay() {
        let directory = tempfile::tempdir().unwrap();
        let pointer = directory.path().join("pointer.json");
        let mut data = serde_json::json!({"version":1,"graphRoot":directory.path(),"bookmarkVersion":2,"targetGraphId":"a".repeat(64)});
        std::fs::write(&pointer, data.to_string()).unwrap();
        assert_eq!(capabilities(&pointer).unwrap()["bookmarkVersion"], 2);
        let payload = fixtures()["accepted"][0].to_string();
        spool(payload.as_bytes(), &pointer).unwrap();
        spool(payload.as_bytes(), &pointer).unwrap();
        assert_eq!(
            std::fs::read_dir(directory.path().join(".reflect/inbox"))
                .unwrap()
                .count(),
            1
        );
        data["targetGraphId"] = "b".repeat(64).into();
        std::fs::write(&pointer, data.to_string()).unwrap();
        assert_eq!(
            spool(payload.as_bytes(), &pointer).unwrap_err(),
            HostError::GraphMismatch
        );
    }
}
