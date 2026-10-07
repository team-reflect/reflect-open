//! Per-device sync preferences, in `.reflect/sync.json`. `.reflect/` never
//! leaves the device (gitignored, local-only under iCloud), so a value here
//! is this device's choice about the graph, not the graph's own state.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

const FILE: &str = ".reflect/sync.json";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncPrefs {
    /// On a graph that iCloud Drive already syncs, this device pushes the
    /// git backup. Off by default: iCloud moves the files between devices,
    /// so one writer is enough, and two produce duplicate commits and merge
    /// churn on every edit (Plan 21 contract 5, revised).
    pub backup_writer: bool,
}

fn load(root: &Path) -> AppResult<SyncPrefs> {
    match std::fs::read_to_string(root.join(FILE)) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|err| AppError::io(err.to_string())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(SyncPrefs::default()),
        Err(err) => Err(err.into()),
    }
}

fn save(root: &Path, prefs: &SyncPrefs) -> AppResult<()> {
    let json = serde_json::to_string_pretty(prefs).map_err(|err| AppError::io(err.to_string()))?;
    crate::fs::atomic_write_bytes(root, &root.join(FILE), json.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn sync_prefs_get(generation: u64, state: State<GraphState>) -> AppResult<SyncPrefs> {
    load(&crate::fs::root_for_generation(&state, generation)?)
}

#[tauri::command]
pub fn sync_prefs_set(
    prefs: SyncPrefs,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    save(&crate::fs::root_for_generation(&state, generation)?, &prefs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_means_defaults_and_save_round_trips() {
        let root = tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".reflect")).unwrap();
        assert!(!load(root.path()).unwrap().backup_writer);
        save(
            root.path(),
            &SyncPrefs {
                backup_writer: true,
            },
        )
        .unwrap();
        assert!(load(root.path()).unwrap().backup_writer);
    }

    #[test]
    fn unknown_keys_are_tolerated() {
        let root = tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".reflect")).unwrap();
        std::fs::write(
            root.path().join(FILE),
            b"{\"backupWriter\": true, \"later\": 1}",
        )
        .unwrap();
        assert!(load(root.path()).unwrap().backup_writer);
    }
}
