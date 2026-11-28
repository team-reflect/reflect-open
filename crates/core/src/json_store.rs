//! A JSON document stored in one file, for the per-user stores in the OS
//! config dir.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tempfile::NamedTempFile;

use reflect_types::{AppError, AppResult};

/// Load the stored document. A missing store is `T::default()`, but a real IO
/// error or malformed JSON is propagated: silently treating a corrupt store as
/// empty would let the next save persist that emptiness and wipe every entry.
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> AppResult<T> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(err) => return Err(AppError::io(err.to_string())),
    };
    serde_json::from_str(&raw).map_err(|err| AppError::io(err.to_string()))
}

/// Write the document to a temp file in the same dir, then atomically rename
/// it over the target, so a crash mid-write cannot truncate the existing store.
pub fn save_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::io(format!("{} has no parent directory", path.display())))?;
    fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(value).map_err(|err| AppError::io(err.to_string()))?;
    let mut tmp = NamedTempFile::new_in(dir)?;
    tmp.write_all(json.as_bytes())?;
    tmp.flush()?;
    tmp.persist(path)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}
