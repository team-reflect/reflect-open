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

/// True when `root` already contains note files (downloaded, or eviction
/// placeholders per `crate::fs::icloud_placeholder_target` — the one home of
/// that grammar).
///
/// Looks one level into the standard note directories rather than requiring
/// `.reflect/meta.json`: the index directory is excluded from sync on
/// purpose, so a synced-down graph arrives as bare `daily/`/`notes/` content.
fn dir_has_notes(root: &Path) -> bool {
    const NOTE_DIRS: [&str; 3] = ["daily", "notes", "templates"];
    NOTE_DIRS.iter().any(|dir| {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
            return false;
        };
        entries.flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.ends_with(".md") || crate::fs::icloud_placeholder_target(&name).is_some()
        })
    })
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod platform {
    use std::path::{Path, PathBuf};

    use objc2_foundation::{NSFileManager, NSString, NSURL};

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
                // Never follow links (they can loop, or point out of the
                // graph) — same rule as the adopt-copy walks below.
                if entry
                    .file_type()
                    .map(|kind| kind.is_symlink())
                    .unwrap_or(true)
                {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let Some(target) = crate::fs::icloud_placeholder_target(&name) else {
                    continue;
                };
                pending += 1;
                if !start_download(&manager, &path) {
                    // Some iOS releases want the logical URL, not the stub.
                    start_download(&manager, &dir.join(target));
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

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
mod platform {
    use std::path::{Path, PathBuf};

    /// No iCloud Drive container off Apple platforms (Android, and
    /// Windows/Linux desktop builds).
    pub fn ubiquity_documents_dir() -> Option<PathBuf> {
        None
    }

    /// Nothing to download without a container.
    pub fn download_pending(_root: &Path) -> u32 {
        0
    }
}

/// iCloud availability as the desktop settings section consumes it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcloudStatus {
    /// True when the app can reach its iCloud Drive container (entitled
    /// build, signed-in account). Dev builds without the provisioning
    /// profile honestly report `false`.
    pub available: bool,
    /// The container's `Documents/` directory when available.
    pub documents_root: Option<String>,
}

/// Command: can this build reach the iCloud container? Runs on a blocking
/// thread — the first `URLForUbiquityContainerIdentifier` call may extend
/// the sandbox and touch the network, and Apple forbids it on the main
/// thread.
#[tauri::command]
pub async fn icloud_status() -> AppResult<IcloudStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        let documents = platform::ubiquity_documents_dir();
        Ok(IcloudStatus {
            available: documents.is_some(),
            documents_root: documents.map(|dir| dir.to_string_lossy().into_owned()),
        })
    })
    .await
    .map_err(|err| AppError::io(err.to_string()))?
}

/// Command: copy the open graph into the iCloud container (Plan 21 Phase 1,
/// the desktop move-in) and return the new root. The copy is verified by
/// file count + byte totals before anything is reported; the original graph
/// is left untouched at its old path as the recovery copy — the caller
/// re-opens at the returned root, which re-bootstraps `.reflect/` and
/// rebuilds the index there.
///
/// `.reflect/` and `.git/` are deliberately not copied: the index is a
/// rebuildable projection, and a backup repo must never ride a file-sync
/// provider. The Git remote, if any, is disconnected by the caller first —
/// iCloud sync and a Git remote are mutually exclusive per graph (Plan 21).
#[tauri::command]
pub async fn icloud_adopt_graph(
    generation: u64,
    state: tauri::State<'_, crate::fs::GraphState>,
) -> AppResult<String> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    tauri::async_runtime::spawn_blocking(move || adopt_graph(&root))
        .await
        .map_err(|err| AppError::io(err.to_string()))?
}

fn adopt_graph(root: &Path) -> AppResult<String> {
    let documents = platform::ubiquity_documents_dir().ok_or_else(|| {
        AppError::io("iCloud Drive is unavailable — sign in to iCloud and try again")
    })?;
    let name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| DEFAULT_ICLOUD_GRAPH_DIR.to_string());
    let target = documents.join(&name);
    if dir_has_notes(&target) {
        return Err(AppError::io(format!(
            "iCloud Drive already contains a graph named \"{name}\" — open that one instead, or rename one of the two"
        )));
    }
    let copied = copy_graph_tree(root, &target)?;
    let landed = count_graph_tree(&target)?;
    if copied != landed {
        return Err(AppError::io(format!(
            "the iCloud copy did not verify (copied {} files / {} bytes, found {} / {}); the original graph is untouched",
            copied.0, copied.1, landed.0, landed.1
        )));
    }
    Ok(target.to_string_lossy().into_owned())
}

/// What stays behind on a move-in: the rebuildable local state, the backup
/// repo, and OS litter.
fn adopt_skips(name: &str) -> bool {
    matches!(name, ".reflect" | ".git" | ".DS_Store")
}

/// Recursively copy the graph tree, returning `(files, bytes)` copied.
fn copy_graph_tree(source: &Path, target: &Path) -> AppResult<(u64, u64)> {
    std::fs::create_dir_all(target)?;
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((from_dir, to_dir)) = stack.pop() {
        for entry in std::fs::read_dir(&from_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if adopt_skips(&name.to_string_lossy()) {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue; // never follow links out of the graph
            }
            let from = entry.path();
            let to = to_dir.join(&name);
            if file_type.is_dir() {
                std::fs::create_dir_all(&to)?;
                stack.push((from, to));
            } else {
                bytes += std::fs::copy(&from, &to)?;
                files += 1;
            }
        }
    }
    Ok((files, bytes))
}

/// Count `(files, bytes)` in a copied tree, with the same skip rules.
fn count_graph_tree(root: &Path) -> AppResult<(u64, u64)> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if adopt_skips(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            } else {
                files += 1;
                bytes += entry.metadata()?.len();
            }
        }
    }
    Ok((files, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn adopt_copy_skips_local_state_and_verifies() {
        let source = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(source.path().join("notes")).expect("mkdir");
        std::fs::create_dir_all(source.path().join(".reflect")).expect("mkdir");
        std::fs::create_dir_all(source.path().join(".git")).expect("mkdir");
        std::fs::write(source.path().join("notes/a.md"), b"# A").expect("write");
        std::fs::write(source.path().join(".reflect/index.sqlite"), b"db").expect("write");
        std::fs::write(source.path().join(".git/HEAD"), b"ref").expect("write");
        std::fs::write(source.path().join(".DS_Store"), b"junk").expect("write");

        let container = tempfile::tempdir().expect("tempdir");
        let target = container.path().join("Notes");
        let copied = copy_graph_tree(source.path(), &target).expect("copy");
        assert_eq!(copied, (1, 3)); // one file, three bytes — the note alone
        assert_eq!(count_graph_tree(&target).expect("count"), copied);
        assert_eq!(
            std::fs::read_to_string(target.join("notes/a.md")).expect("read"),
            "# A"
        );
        assert!(!target.join(".reflect").exists());
        assert!(!target.join(".git").exists());
        assert!(!target.join(".DS_Store").exists());
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
