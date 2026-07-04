//! iCloud Drive document storage for the mobile graph (Plan 21).
//!
//! iCloud document sync is the primary way phone + desktop share a graph:
//! per Plan 21 contract 1 the graph lives at `<container>/Documents/<name>/`
//! in the app's iCloud Drive container (visible as "Reflect" in the Files
//! app and in Finder's iCloud Drive), and the OS moves the markdown between
//! devices. Rust owns only the storage primitives — resolving the
//! container, finding an existing graph inside it, and nudging undownloaded
//! files ("dataless" `.icloud` placeholders) onto the device. Which root
//! the graph actually opens in is frontend policy (`GraphProvider` + the
//! onboarding screen).
//!
//! Platform shape mirrors `contacts.rs`: real implementations on iOS, an
//! honest "no iCloud here" answer elsewhere, and the commands registered on
//! every platform so the IPC surface never branches.

use std::path::{Path, PathBuf};

use serde::Serialize;
#[cfg(mobile)]
use tauri::Manager;

use crate::error::{AppError, AppResult};

/// The graph directory created inside the container for a fresh start. A
/// plain, human name — it reads as `iCloud Drive → Reflect → Notes` in
/// Files/Finder, and becomes the graph's display name. (Referenced only by
/// the mobile `mobile_storage` body, hence the desktop allowance.)
#[cfg_attr(desktop, allow(dead_code))]
const DEFAULT_ICLOUD_GRAPH_DIR: &str = "Notes";

/// The storage locations available to the mobile graph, as the onboarding
/// screen and `GraphProvider` consume them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileStorage {
    /// The app-sandbox `Documents/` directory — always available, never
    /// synced. iOS container paths embed a UUID that changes across
    /// restore/update, so callers must never persist this absolute path.
    pub local_root: String,
    /// The graph directory inside the app's iCloud Drive container
    /// (`<container>/Documents/<name>/`, Plan 21 contract 1), when iCloud
    /// Drive is usable (entitled build + signed-in account): an existing
    /// graph directory when one is found, otherwise the default one to
    /// create. `None` when the user is signed out of iCloud or the platform
    /// has no iCloud. Same rule as `local_root`: derive fresh, never persist.
    pub icloud_root: Option<String>,
    /// True when `icloud_root` is an existing graph (notes or placeholders
    /// for notes not yet downloaded) — a returning user. Best-effort:
    /// content still syncing down at first launch can flip this later, which
    /// only relabels the onboarding button.
    pub icloud_has_graph: bool,
}

/// Command: resolve the mobile storage locations. Mobile-only; desktop picks
/// its graph folders through the chooser and has no fixed roots.
///
/// Runs on a blocking thread: the first `URLForUbiquityContainerIdentifier`
/// call may extend the app sandbox and touch the network, and Apple forbids
/// it on the main thread.
#[tauri::command]
pub async fn mobile_storage(app: tauri::AppHandle) -> AppResult<MobileStorage> {
    #[cfg(mobile)]
    {
        let local = app
            .path()
            .document_dir()
            .map_err(|err| AppError::io(format!("no documents directory: {err}")))?;
        tauri::async_runtime::spawn_blocking(move || {
            let documents = platform::ubiquity_documents_dir();
            let existing = documents.as_deref().and_then(find_graph_dir);
            let icloud_has_graph = existing.is_some();
            let icloud_root = match (existing, documents) {
                (Some(graph), _) => Some(graph),
                (None, Some(documents)) => Some(documents.join(DEFAULT_ICLOUD_GRAPH_DIR)),
                (None, None) => None,
            };
            Ok(MobileStorage {
                local_root: local.to_string_lossy().into_owned(),
                icloud_root: icloud_root.map(|dir| dir.to_string_lossy().into_owned()),
                icloud_has_graph,
            })
        })
        .await
        .map_err(|err| AppError::io(err.to_string()))?
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Err(AppError::Unknown {
            message: "mobile_storage is mobile-only".into(),
        })
    }
}

/// Command: ask iCloud to download every not-yet-local file under `root`,
/// returning how many placeholders were found. iCloud does not pull files
/// down eagerly on iOS, so an edit made on the Mac exists only as a
/// `.name.md.icloud` stub until something requests it. The frontend calls
/// this on open/resume for iCloud graphs and re-reconciles while the count
/// stays above zero.
#[tauri::command]
pub async fn icloud_download_pending(root: String) -> AppResult<u32> {
    tauri::async_runtime::spawn_blocking(move || Ok(platform::download_pending(Path::new(&root))))
        .await
        .map_err(|err| AppError::io(err.to_string()))?
}

/// Find an existing graph among the container `Documents/` subdirectories:
/// the first (by name, for determinism) that holds notes. Multiple graph
/// directories are possible once desktop migration lands (Plan 21 Phase 1);
/// v1 mobile opens the first and leaves choosing among several to later.
///
/// Only the mobile `mobile_storage` body reaches this at runtime — desktop
/// builds compile it for the tests alone, hence the dead-code allowance.
#[cfg_attr(desktop, allow(dead_code))]
fn find_graph_dir(documents: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(documents).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs.into_iter().find(|dir| dir_has_notes(dir))
}

/// True when `root` already contains note files (downloaded or placeholder).
///
/// Looks one level into the standard note directories rather than requiring
/// `.reflect/meta.json`: the index directory is excluded from sync on
/// purpose, so a synced-down graph arrives as bare `daily/`/`notes/` content.
#[cfg_attr(desktop, allow(dead_code))]
fn dir_has_notes(root: &Path) -> bool {
    const NOTE_DIRS: [&str; 3] = ["daily", "notes", "templates"];
    NOTE_DIRS.iter().any(|dir| {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
            return false;
        };
        entries.flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.ends_with(".md") || is_icloud_placeholder(&name)
        })
    })
}

/// iCloud represents a not-downloaded file as a hidden `.{name}.icloud` stub.
#[cfg_attr(desktop, allow(dead_code))]
fn is_icloud_placeholder(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".icloud")
}

/// Strip the placeholder mangling: `.note.md.icloud` → `note.md`.
#[cfg_attr(desktop, allow(dead_code))]
fn placeholder_target(name: &str) -> Option<&str> {
    name.strip_prefix('.')?.strip_suffix(".icloud")
}

#[cfg(target_os = "ios")]
mod platform {
    use std::path::{Path, PathBuf};

    use objc2_foundation::{NSFileManager, NSString, NSURL};

    use super::{is_icloud_placeholder, placeholder_target};

    /// The container's `Documents/` directory, created if missing. `None`
    /// when iCloud Drive is unavailable (signed out, entitlement missing).
    pub fn ubiquity_documents_dir() -> Option<PathBuf> {
        let manager = NSFileManager::defaultManager();
        let container = manager.URLForUbiquityContainerIdentifier(None)?;
        let path = container.path()?.to_string();
        let documents = PathBuf::from(path).join("Documents");
        if let Err(err) = std::fs::create_dir_all(&documents) {
            tracing::warn!(%err, "failed to create iCloud Documents directory");
            return None;
        }
        Some(documents)
    }

    /// Walk `root` and request a download for every `.icloud` placeholder.
    /// Returns the number of placeholders seen. Individual failures are
    /// logged and skipped — one undownloadable file must not stop the rest.
    pub fn download_pending(root: &Path) -> u32 {
        let manager = NSFileManager::defaultManager();
        let mut pending = 0;
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !is_icloud_placeholder(&name) {
                    continue;
                }
                pending += 1;
                if !start_download(&manager, &path) {
                    // Some iOS releases want the logical URL, not the stub.
                    if let Some(target) = placeholder_target(&name) {
                        start_download(&manager, &dir.join(target));
                    }
                }
            }
        }
        pending
    }

    fn start_download(manager: &NSFileManager, path: &Path) -> bool {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        match manager.startDownloadingUbiquitousItemAtURL_error(&url) {
            Ok(()) => true,
            Err(err) => {
                tracing::warn!(path = %path.display(), %err, "iCloud download request failed");
                false
            }
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod platform {
    use std::path::{Path, PathBuf};

    /// No iCloud Drive container off-iOS (Android, and desktop dev builds
    /// exercising the mobile tree).
    #[cfg_attr(desktop, allow(dead_code))]
    pub fn ubiquity_documents_dir() -> Option<PathBuf> {
        None
    }

    /// Nothing to download without a container.
    pub fn download_pending(_root: &Path) -> u32 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_names_round_trip() {
        assert!(is_icloud_placeholder(".2026-07-04.md.icloud"));
        assert!(!is_icloud_placeholder("2026-07-04.md"));
        assert!(!is_icloud_placeholder(".hidden"));
        assert_eq!(
            placeholder_target(".2026-07-04.md.icloud"),
            Some("2026-07-04.md")
        );
    }

    #[test]
    fn find_graph_dir_picks_the_first_directory_with_notes() {
        let documents = tempfile::tempdir().expect("tempdir");
        assert_eq!(find_graph_dir(documents.path()), None);

        // An empty graph dir (e.g. created then abandoned) is not a graph.
        std::fs::create_dir_all(documents.path().join("Empty/daily")).expect("mkdir");
        assert_eq!(find_graph_dir(documents.path()), None);

        std::fs::create_dir_all(documents.path().join("Notes/daily")).expect("mkdir");
        std::fs::write(documents.path().join("Notes/daily/2026-07-04.md"), b"# hi").expect("write");
        assert_eq!(
            find_graph_dir(documents.path()),
            Some(documents.path().join("Notes"))
        );

        // Deterministic under multiple graphs: first by name.
        std::fs::create_dir_all(documents.path().join("Archive/notes")).expect("mkdir");
        std::fs::write(
            documents.path().join("Archive/notes/.old.md.icloud"),
            b"stub",
        )
        .expect("write");
        assert_eq!(
            find_graph_dir(documents.path()),
            Some(documents.path().join("Archive"))
        );
    }

    #[test]
    fn dir_has_notes_sees_markdown_and_placeholders() {
        let root = tempfile::tempdir().expect("tempdir");
        assert!(!dir_has_notes(root.path()));

        std::fs::create_dir_all(root.path().join("daily")).expect("mkdir");
        assert!(!dir_has_notes(root.path()));

        std::fs::write(root.path().join("daily/.2026-07-04.md.icloud"), b"stub").expect("write");
        assert!(dir_has_notes(root.path()));

        let downloaded = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(downloaded.path().join("notes")).expect("mkdir");
        std::fs::write(downloaded.path().join("notes/idea.md"), b"# hi").expect("write");
        assert!(dir_has_notes(downloaded.path()));
    }
}
