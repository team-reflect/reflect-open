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
    uuid::Uuid::parse_str(id).map_err(|_| invalid())?;
    if envelope["source"] != "extension"
        // FIXME: regular captures validate this field with `envelope::is_iso_datetime`; reuse it
        // here (and `is_uuid` above) instead of a weaker `is_string` check, and inline the post-id
        // digit check to drop the `reflect-x-archive` dependency from this binary (see the crate
        // FIXME).
        || !envelope["capturedAt"].is_string()
        || !envelope["data"]["id"]
            .as_str()
            .is_some_and(reflect_x_archive::valid_id)
    {
        return Err(invalid());
    }
    let inbox = spool::inbox_dir(pointer)?;
    let bytes = serde_json::to_vec(envelope).map_err(|error| HostError::Io(error.to_string()))?;
    spool::atomic_write(&inbox, &format!("{id}.json"), &bytes)
}
