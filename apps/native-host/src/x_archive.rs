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
