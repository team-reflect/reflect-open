use crate::{spool, HostError};
use serde_json::Value;
use std::path::Path;

/// Spool post data only. The desktop downloads the referenced CDN media.
pub fn spool(envelope: &Value, pointer: &Path) -> Result<(), HostError> {
    let invalid = || HostError::InvalidPayload("Invalid X capture".into());
    if envelope["version"] != 2 {
        return Err(HostError::UnsupportedVersion);
    }
    let kind = envelope["kind"].as_str().ok_or_else(invalid)?;
    if !matches!(kind, "x-bookmark" | "x-like") {
        return Err(invalid());
    }
    if kind == "x-like" {
        let fields = envelope.as_object().ok_or_else(invalid)?;
        if fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                "version" | "kind" | "id" | "source" | "capturedAt" | "postId" | "data"
            )
        }) || (fields.contains_key("data") && fields.contains_key("postId"))
        {
            return Err(invalid());
        }
    }
    let id = envelope["id"].as_str().ok_or_else(invalid)?;
    if !crate::envelope::is_uuid(id) {
        return Err(invalid());
    }
    let post_id = match envelope.get("data") {
        Some(data) => data["id"].as_str(),
        None => envelope["postId"].as_str(),
    };
    if envelope["source"] != "extension"
        || !envelope["capturedAt"]
            .as_str()
            .is_some_and(crate::envelope::is_iso_datetime)
        || !post_id.is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 20
                && !id.starts_with('0')
                && id.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err(invalid());
    }
    let pointer = spool::read_pointer(pointer)?;
    if envelope["kind"] == "x-like" && pointer.x_like_version != Some(2) {
        return Err(HostError::UnsupportedVersion);
    }
    let inbox = Path::new(&pointer.graph_root).join(".reflect/inbox");
    std::fs::create_dir_all(&inbox).map_err(|error| HostError::Io(error.to_string()))?;
    let bytes = serde_json::to_vec(envelope).map_err(|error| HostError::Io(error.to_string()))?;
    spool::atomic_write(&inbox, &format!("{id}.json"), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_invalid_capture_metadata_before_spooling() {
        let valid = json!({
            "version": 2, "kind": "x-bookmark", "source": "extension",
            "id": "12345678-1234-4234-8234-123456789abc",
            "capturedAt": "2026-09-14T00:00:00Z", "data": {"id": "123"}
        });
        for (field, invalid) in [
            ("id", "../escape"),
            ("capturedAt", "yesterday"),
            ("capturedAt", "2026-02-30T00:00:00Z"),
        ] {
            let mut envelope = valid.clone();
            envelope[field] = json!(invalid);
            assert!(matches!(
                spool(&envelope, Path::new("/missing-pointer")),
                Err(HostError::InvalidPayload(_))
            ));
        }
        for id in ["", "0123", "../123", "123456789012345678901"] {
            let mut envelope = valid.clone();
            envelope["data"]["id"] = json!(id);
            assert!(matches!(
                spool(&envelope, Path::new("/missing-pointer")),
                Err(HostError::InvalidPayload(_))
            ));
        }
    }

    #[test]
    fn matches_like_metadata_fixtures_and_preserves_snapshots() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../packages/core/src/actions/like-envelope.fixtures.json"
        ))
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let pointer = directory.path().join("pointer.json");
        std::fs::write(
            &pointer,
            json!({
                "version": 1, "graphRoot": directory.path(), "xLikeVersion": 2,
            })
            .to_string(),
        )
        .unwrap();
        for wire in fixtures["accepted"].as_array().unwrap() {
            spool(&wire["envelope"], &pointer).unwrap();
        }
        for wire in fixtures["rejected"].as_array().unwrap() {
            if wire.get("screenshotBase64").is_some() {
                continue;
            }
            assert!(spool(&wire["envelope"], &pointer).is_err(), "{wire}");
        }
        let mut snapshot = fixtures["accepted"][0]["envelope"].clone();
        snapshot.as_object_mut().unwrap().remove("postId");
        snapshot["data"] = json!({
            "id": "20", "createdAt": "", "author": {"name": "", "handle": ""}, "body": [],
        });
        spool(&snapshot, &pointer).unwrap();
        let output = directory
            .path()
            .join(".reflect/inbox")
            .join(format!("{}.json", snapshot["id"].as_str().unwrap()));
        let saved: Value = serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
        assert_eq!(saved, snapshot);
    }
}
