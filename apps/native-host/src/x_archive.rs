use crate::{spool, HostError};
use serde_json::Value;
use std::path::Path;

/// Spool post data only. The desktop downloads the referenced CDN media.
pub fn spool(envelope: &Value, pointer: &Path) -> Result<(), HostError> {
    let invalid = || HostError::InvalidPayload("Invalid X capture".into());
    if envelope["version"] != 2 {
        return Err(HostError::UnsupportedVersion);
    }
    let id = envelope["id"].as_str().ok_or_else(invalid)?;
    if !crate::envelope::is_uuid(id) {
        return Err(invalid());
    }
    if envelope["source"] != "extension"
        || !envelope["capturedAt"]
            .as_str()
            .is_some_and(crate::envelope::is_iso_datetime)
        || !envelope["data"]["id"].as_str().is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 20
                && !id.starts_with('0')
                && id.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err(invalid());
    }
    let inbox = spool::inbox_dir(pointer)?;
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
            "version": 2, "source": "extension",
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
}
