//! User settings store: one JSON document in the OS config dir.
//!
//! Settings live next to the recents store — **never** inside any one graph's
//! `.reflect/` — because they are per-user preferences that must follow the
//! user across graphs and survive graph deletion. Rust treats the document as
//! an opaque JSON object (a capability, per the architecture conventions);
//! the schema, defaults, and validation are policy and live in
//! `@reflect/core`'s zod layer.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

/// The settings document: a JSON object keyed by setting name. `Map` (not
/// `Value`) so a non-object payload is rejected at deserialization.
pub type SettingsDoc = Map<String, Value>;

fn store_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir"))?;
    Ok(base.join("reflect-open").join("settings.json"))
}

/// Load the stored document. A missing store is an empty object, but a real IO
/// error or malformed JSON is propagated — silently treating a corrupt store as
/// empty would let the next save persist that emptiness and wipe every setting.
fn load_from(path: &Path) -> AppResult<SettingsDoc> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(SettingsDoc::new()),
        Err(err) => return Err(AppError::io(err.to_string())),
    };
    serde_json::from_str(&raw).map_err(|err| AppError::io(err.to_string()))
}

fn save_to(path: &Path, settings: &SettingsDoc) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::io("settings store path has no parent directory"))?;
    fs::create_dir_all(dir)?;
    let json =
        serde_json::to_string_pretty(settings).map_err(|err| AppError::io(err.to_string()))?;
    // Write to a temp file in the same dir, then atomically rename over the
    // target so a crash mid-write can't truncate the existing store.
    let mut tmp = NamedTempFile::new_in(dir)?;
    tmp.write_all(json.as_bytes())?;
    tmp.flush()?;
    tmp.persist(path)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

/// Command: the persisted settings document (an empty object on first run).
#[tauri::command]
pub fn settings_load() -> AppResult<SettingsDoc> {
    load_from(&store_path()?)
}

/// Command: atomically replace the persisted settings document.
#[tauri::command]
pub fn settings_save(settings: SettingsDoc) -> AppResult<()> {
    save_to(&store_path()?, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn doc(entries: &[(&str, Value)]) -> SettingsDoc {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn save_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = doc(&[("editorMarkMode", json!("show"))]);
        save_to(&path, &settings).unwrap();
        assert_eq!(load_from(&path).unwrap(), settings);
    }

    #[test]
    fn missing_store_loads_empty() {
        let dir = tempdir().unwrap();
        assert!(load_from(&dir.path().join("nope.json")).unwrap().is_empty());
    }

    #[test]
    fn corrupt_store_errors_instead_of_wiping() {
        // A malformed store must surface an error, not silently read as empty
        // (which a later save would persist, destroying the real settings).
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"{ this is not json").unwrap();
        assert!(load_from(&path).is_err());
    }

    #[test]
    fn non_object_store_errors() {
        // The document contract is a JSON object; a stray array/string must not
        // load (and then round-trip) as if it were settings.
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"[1, 2, 3]").unwrap();
        assert!(load_from(&path).is_err());
    }

    #[test]
    fn save_creates_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        save_to(&path, &doc(&[("theme", json!("dark"))])).unwrap();
        assert_eq!(load_from(&path).unwrap(), doc(&[("theme", json!("dark"))]));
    }
}
