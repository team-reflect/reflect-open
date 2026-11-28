//! User settings store: one JSON document in the OS config dir.
//!
//! Settings live next to the recents store — **never** inside any one graph's
//! `.reflect/` — because they are per-user preferences that must follow the
//! user across graphs and survive graph deletion. Rust treats the document as
//! an opaque JSON object (a capability, per the architecture conventions);
//! the schema, defaults, and validation are policy and live in
//! `@reflect/core`'s zod layer.

use std::path::PathBuf;

use reflect_types::{AppError, AppResult, SettingsDoc};

use crate::Core;
use crate::json_store::{load_json, save_json};

fn store_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir"))?;
    Ok(base.join("reflect-open").join("settings.json"))
}

impl Core {
    /// Command: the persisted settings document (an empty object on first run).
    pub fn settings_load(&self) -> AppResult<SettingsDoc> {
        load_json(&store_path()?)
    }

    /// Command: atomically replace the persisted settings document.
    pub fn settings_save(&self, settings: SettingsDoc) -> AppResult<()> {
        save_json(&store_path()?, &settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Reply;
    use crate::test_support::core;
    use serde_json::{Value, json};
    use std::fs;
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
        let settings = doc(&[("editorMarkdownSyntax", json!("show"))]);
        save_json(&path, &settings).unwrap();
        assert_eq!(load_json::<SettingsDoc>(&path).unwrap(), settings);
    }

    #[test]
    fn missing_store_loads_empty() {
        let dir = tempdir().unwrap();
        assert!(
            load_json::<SettingsDoc>(&dir.path().join("nope.json"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn corrupt_store_errors_instead_of_wiping() {
        // A malformed store must surface an error, not silently read as empty
        // (which a later save would persist, destroying the real settings).
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"{ this is not json").unwrap();
        assert!(load_json::<SettingsDoc>(&path).is_err());
    }

    #[test]
    fn non_object_store_errors() {
        // The document contract is a JSON object; a stray array/string must not
        // load (and then round-trip) as if it were settings.
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"[1, 2, 3]").unwrap();
        assert!(load_json::<SettingsDoc>(&path).is_err());
    }

    #[test]
    fn dispatch_returns_the_typed_result_as_json() {
        let core = core();
        let typed = core
            .settings_load()
            .map(|doc| Reply::Json(serde_json::to_string(&doc).unwrap()));
        let dispatched = core
            .runtime
            .block_on(core.dispatch("settings_load", b"{}", b"{}", None));
        assert_eq!(format!("{dispatched:?}"), format!("{typed:?}"));
    }

    #[test]
    fn save_creates_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        save_json(&path, &doc(&[("theme", json!("dark"))])).unwrap();
        assert_eq!(
            load_json::<SettingsDoc>(&path).unwrap(),
            doc(&[("theme", json!("dark"))])
        );
    }
}
