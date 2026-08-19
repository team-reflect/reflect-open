//! Live-note ownership across webviews and Reflect processes.
//!
//! An editor claims its path before loading and retains the claim until its
//! final flush settles. AI reads and revision-guarded mutations probe these
//! claims while holding the graph mutation lock, so an unsaved buffer in a
//! detached window or another Reflect flavor can never be mistaken for the
//! authoritative on-disk note.

use std::collections::HashMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use sha2::{Digest, Sha256};
use tauri::State;
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, AppResult};
use crate::fs::{self as graph_fs, GraphState};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct LeaseKey {
    root: PathBuf,
    identity: String,
}

#[derive(Debug)]
struct LocalOwner {
    owner_id: String,
    window_label: String,
    path: String,
}

struct PathOwnership {
    owners: Vec<LocalOwner>,
    lease_path: PathBuf,
    lease_file: File,
}

#[derive(Default)]
struct OwnershipInner {
    paths: HashMap<LeaseKey, PathOwnership>,
}

/// Process-wide live editor claims. Each path also holds an OS-backed lease
/// file so another Reflect process opening the same graph can fail closed.
pub struct NoteWindowOwnershipState {
    process_session: String,
    inner: Mutex<OwnershipInner>,
}

impl Default for NoteWindowOwnershipState {
    fn default() -> Self {
        static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
        let epoch_nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        Self {
            process_session: format!(
                "{}-{epoch_nanos}-{}",
                std::process::id(),
                NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
            ),
            inner: Mutex::new(OwnershipInner::default()),
        }
    }
}

impl NoteWindowOwnershipState {
    fn lock(&self) -> AppResult<MutexGuard<'_, OwnershipInner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::io("note ownership lock poisoned"))
    }

    fn claim_locked(
        &self,
        root: &Path,
        path: &str,
        owner_id: &str,
        window_label: &str,
    ) -> AppResult<()> {
        validate_owner_id(owner_id)?;
        let root = root.canonicalize()?;
        let keys = candidate_lease_identities(&root, path)?
            .into_iter()
            .map(|identity| LeaseKey {
                root: root.clone(),
                identity,
            })
            .collect::<Vec<_>>();
        let mut inner = self.lock()?;
        if inner.paths.values().any(|ownership| {
            ownership
                .owners
                .iter()
                .any(|owner| owner.owner_id == owner_id && owner.window_label != window_label)
        }) {
            return Err(AppError::io("note ownership id is already in use"));
        }

        ensure_real_directory(&root.join(".reflect"))?;
        ensure_real_directory(&root.join(".reflect").join("note-owners"))?;
        let mut new_ownerships = Vec::new();
        for key in &keys {
            if inner.paths.contains_key(key) {
                continue;
            }
            let lease_dir = lease_directory(&root, &key.identity);
            ensure_real_directory(&lease_dir)?;
            let lease_path = lease_dir.join(format!("{}.lock", self.process_session));
            let lease_file = open_real_lease_file(&lease_path)?;
            lease_file.lock()?;
            new_ownerships.push((
                key.clone(),
                PathOwnership {
                    owners: Vec::new(),
                    lease_path,
                    lease_file,
                },
            ));
        }
        for (key, ownership) in new_ownerships {
            inner.paths.insert(key, ownership);
        }
        for key in keys {
            let ownership = inner.paths.get_mut(&key).expect("claim lease was inserted");
            if !ownership.owners.iter().any(|owner| {
                owner.owner_id == owner_id
                    && owner.window_label == window_label
                    && owner.path == path
            }) {
                ownership.owners.push(LocalOwner {
                    owner_id: owner_id.to_owned(),
                    window_label: window_label.to_owned(),
                    path: path.to_owned(),
                });
            }
        }
        Ok(())
    }

    fn release_locked(&self, path: &str, owner_id: &str, window_label: &str) -> AppResult<()> {
        let mut inner = self.lock()?;
        let keys = inner
            .paths
            .iter_mut()
            .filter_map(|(key, ownership)| {
                ownership.owners.retain(|owner| {
                    owner.owner_id != owner_id
                        || owner.window_label != window_label
                        || owner.path != path
                });
                ownership.owners.is_empty().then(|| key.clone())
            })
            .collect::<Vec<_>>();
        let mut first_error = None;
        for key in keys {
            if let Some(ownership) = inner.paths.remove(&key) {
                if let Err(error) = release_lease(ownership) {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn roots_for_owner(&self, path: &str, owner_id: &str, window_label: &str) -> Vec<PathBuf> {
        self.lock()
            .map(|inner| {
                let mut roots = Vec::new();
                for (key, ownership) in &inner.paths {
                    if ownership.owners.iter().any(|owner| {
                        owner.owner_id == owner_id
                            && owner.window_label == window_label
                            && owner.path == path
                    }) && !roots.contains(&key.root)
                    {
                        roots.push(key.root.clone());
                    }
                }
                roots
            })
            .unwrap_or_default()
    }

    fn roots_for_window(&self, window_label: &str) -> Vec<PathBuf> {
        self.lock()
            .map(|inner| {
                let mut roots = Vec::new();
                for (key, ownership) in &inner.paths {
                    if ownership
                        .owners
                        .iter()
                        .any(|owner| owner.window_label == window_label)
                        && !roots.contains(&key.root)
                    {
                        roots.push(key.root.clone());
                    }
                }
                roots
            })
            .unwrap_or_default()
    }

    fn release_window_locked(&self, root: &Path, window_label: &str) -> AppResult<()> {
        let mut inner = self.lock()?;
        let keys: Vec<LeaseKey> = inner
            .paths
            .iter_mut()
            .filter_map(|(key, ownership)| {
                if key.root != root {
                    return None;
                }
                ownership
                    .owners
                    .retain(|owner| owner.window_label != window_label);
                ownership.owners.is_empty().then(|| key.clone())
            })
            .collect();
        let mut first_error = None;
        for key in keys {
            if let Some(ownership) = inner.paths.remove(&key) {
                if let Err(error) = release_lease(ownership) {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Called from an AI critical section that already holds the graph's
    /// cross-process mutation lock. Probe failures deliberately return false.
    pub(crate) fn ai_access_available(
        &self,
        root: &Path,
        path: &str,
        requester_label: &str,
        requester_owner_id: Option<&str>,
    ) -> AppResult<bool> {
        if let Some(owner_id) = requester_owner_id {
            validate_owner_id(owner_id)?;
        }
        let root = root.canonicalize()?;
        let identities = candidate_lease_identities(&root, path)?;
        {
            let inner = self.lock()?;
            for identity in &identities {
                let key = LeaseKey {
                    root: root.clone(),
                    identity: identity.clone(),
                };
                if inner.paths.get(&key).is_some_and(|ownership| {
                    ownership.owners.iter().any(|owner| {
                        requester_owner_id != Some(owner.owner_id.as_str())
                            || owner.window_label != requester_label
                    })
                }) {
                    return Ok(false);
                }
            }
        }

        for identity in identities {
            if !self.external_leases_available(&root, &identity) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn external_leases_available(&self, root: &Path, identity: &str) -> bool {
        let directory = lease_directory(root, identity);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return false;
            };
            let file_name = entry.file_name();
            let is_own_lease = file_name
                .to_str()
                .is_some_and(|name| name == format!("{}.lock", self.process_session));
            if is_own_lease {
                continue;
            }
            let file = match open_existing_real_lease_file(&entry.path()) {
                Ok(Some(file)) => file,
                Ok(None) => continue,
                Err(_) => return false,
            };
            match file.try_lock() {
                Ok(()) => {
                    let _ = file.unlock();
                    let _ = fs::remove_file(entry.path());
                }
                Err(std::fs::TryLockError::WouldBlock) => return false,
                Err(_) => return false,
            }
        }
        let _ = remove_empty_lease_directory(&directory);
        true
    }
}

/// Claim a live editor path before loading its bytes. One owner may
/// conservatively claim both sides of a move until the filesystem move lands.
#[tauri::command]
pub fn note_window_claim(
    path: String,
    owner_id: String,
    generation: u64,
    window: tauri::WebviewWindow,
    graph: State<GraphState>,
    ownership: State<NoteWindowOwnershipState>,
) -> AppResult<()> {
    graph_fs::ensure_note_ownership_path(&path)?;
    let root = graph_fs::root_for_generation(&graph, generation)?;
    graph_fs::with_file_mutation_lock(&root, || {
        ownership.claim_locked(&root, &path, &owner_id, window.label())
    })
}

/// Release one exact owner/path pair. Generation is intentionally absent:
/// teardown after a graph switch must still be able to drop the old claim.
#[tauri::command]
pub fn note_window_release(
    path: String,
    owner_id: String,
    window: tauri::WebviewWindow,
    ownership: State<NoteWindowOwnershipState>,
) -> AppResult<()> {
    validate_owner_id(&owner_id)?;
    for root in ownership.roots_for_owner(&path, &owner_id, window.label()) {
        graph_fs::with_file_mutation_lock(&root, || {
            ownership.release_locked(&path, &owner_id, window.label())
        })?;
    }
    Ok(())
}

/// Drop every claim held by one webview. Normal teardown releases after
/// flushing; page-load start and window destruction use this as the reload,
/// crash, and forced-close backstop.
pub(crate) fn release_window(ownership: &NoteWindowOwnershipState, window_label: &str) {
    for root in ownership.roots_for_window(window_label) {
        if let Err(error) = graph_fs::with_file_mutation_lock(&root, || {
            ownership.release_window_locked(&root, window_label)
        }) {
            tracing::warn!(?error, %window_label, "failed to release destroyed note window claims");
        }
    }
}

fn validate_owner_id(owner_id: &str) -> AppResult<()> {
    if !owner_id.is_empty()
        && owner_id.len() <= 128
        && owner_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Ok(());
    }
    Err(AppError::traversal("invalid note ownership id"))
}

fn release_lease(ownership: PathOwnership) -> AppResult<()> {
    let lease_directory = ownership.lease_path.parent().map(Path::to_path_buf);
    ownership.lease_file.unlock()?;
    drop(ownership.lease_file);
    match fs::remove_file(&ownership.lease_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Some(directory) = lease_directory {
        remove_empty_lease_directory(&directory)?;
    }
    Ok(())
}

fn remove_empty_lease_directory(path: &Path) -> AppResult<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn candidate_lease_identities(root: &Path, path: &str) -> AppResult<Vec<String>> {
    graph_fs::ensure_note_ownership_path(path)?;
    // The path identity is always held, even for an existing file. If a
    // non-cooperating writer replaces that inode while an editor remains
    // dirty, AI access to the same logical path must stay blocked.
    let path_identity = path_lease_identity(path);
    let mut identities = vec![path_identity];
    if let Some(existing) = existing_lease_identity(root, path)? {
        if !identities.contains(&existing) {
            identities.push(existing);
        }
    }
    Ok(identities)
}

fn existing_lease_identity(root: &Path, path: &str) -> AppResult<Option<String>> {
    graph_fs::ensure_note_ownership_path(path)?;
    let target = graph_fs::resolve_note_path(root, path)?;
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let canonical = target.canonicalize()?;
            canonical.strip_prefix(root.canonicalize()?).map_err(|_| {
                AppError::traversal("canonical note ownership path escaped the graph")
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                Ok(Some(format!("file:{}:{}", metadata.dev(), metadata.ino())))
            }
            #[cfg(not(unix))]
            {
                let relative = canonical.strip_prefix(root.canonicalize()?).map_err(|_| {
                    AppError::traversal("canonical note ownership path escaped the graph")
                })?;
                let wire = reflect_graph_paths::wire_path(relative).ok_or_else(|| {
                    AppError::traversal("canonical note ownership path is not a wire path")
                })?;
                Ok(Some(format!("existing:{wire}")))
            }
        }
        Ok(_) => Err(AppError::traversal(format!(
            "note ownership target must be a real file: {path}"
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn path_lease_identity(path: &str) -> String {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    let normalized = {
        let lowered: String = path.nfc().flat_map(char::to_lowercase).collect();
        lowered.nfc().collect::<String>()
    };
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    let normalized = path.to_owned();
    format!("path:{normalized}")
}

fn lease_directory(root: &Path, identity: &str) -> PathBuf {
    let digest = Sha256::digest(identity.as_bytes());
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    root.join(".reflect").join("note-owners").join(hash)
}

fn ensure_real_directory(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(AppError::traversal(format!(
            "note ownership lease path must be a real directory: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure_real_directory(path)
            }
            Err(error) => Err(error.into()),
        },
        Err(error) => Err(error.into()),
    }
}

fn open_real_lease_file(path: &Path) -> AppResult<File> {
    loop {
        match open_existing_real_lease_file(path)? {
            Some(file) => return Ok(file),
            None => match fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(file) => return Ok(file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            },
        }
    }
}

fn open_existing_real_lease_file(path: &Path) -> AppResult<Option<File>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let file = fs::OpenOptions::new().read(true).write(true).open(path)?;
            if !file.metadata()?.is_file() {
                return Err(AppError::traversal(format!(
                    "note ownership lease path must be a real file: {}",
                    path.display()
                )));
            }
            Ok(Some(file))
        }
        Ok(_) => Err(AppError::traversal(format!(
            "note ownership lease path must be a real file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> tempfile::TempDir {
        let graph = tempfile::tempdir().unwrap();
        graph_fs::bootstrap_for_test(graph.path()).unwrap();
        graph
    }

    #[test]
    fn only_the_exact_requesting_owner_remains_available() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/a.md", "owner-1", "note-a")?;
            assert!(!state.ai_access_available(graph.path(), "notes/a.md", "note-a", None)?);
            assert!(state.ai_access_available(
                graph.path(),
                "notes/a.md",
                "note-a",
                Some("owner-1")
            )?);
            assert!(!state.ai_access_available(graph.path(), "notes/a.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    #[test]
    fn absent_case_variants_share_the_folded_lease() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/API.md", "owner-1", "note-a")?;
            assert!(!state.ai_access_available(graph.path(), "notes/api.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    #[test]
    fn absent_unicode_case_variants_share_the_folded_lease() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/CAFÉ.md", "owner-1", "note-a")?;
            assert!(!state.ai_access_available(graph.path(), "notes/café.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn templates_can_be_owned_without_becoming_ai_writable() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "templates/journal.md", "owner-1", "note-a")?;
            assert!(!state.ai_access_available(
                graph.path(),
                "templates/journal.md",
                "main",
                None
            )?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn existing_filesystem_case_aliases_share_the_canonical_lease() {
        let graph = graph();
        fs::write(graph.path().join("notes/API.md"), "# API\n").unwrap();
        if !graph.path().join("notes/api.md").exists() {
            return;
        }
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/API.md", "owner-1", "note-a")?;
            assert!(!state.ai_access_available(graph.path(), "notes/api.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn replacing_an_owned_file_does_not_bypass_its_path_lease() {
        let graph = graph();
        let path = graph.path().join("notes/a.md");
        fs::write(&path, "# Before\n").unwrap();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/a.md", "owner-1", "note-a")?;
            fs::remove_file(&path)?;
            fs::write(&path, "# Replacement\n")?;
            assert!(!state.ai_access_available(graph.path(), "notes/a.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn hardlinked_note_aliases_share_the_file_identity_lease() {
        let graph = graph();
        let first = graph.path().join("notes/a.md");
        let alias = graph.path().join("notes/alias.md");
        fs::write(&first, "# Shared\n").unwrap();
        fs::hard_link(&first, &alias).unwrap();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/a.md", "owner-1", "note-a")?;
            assert!(!state.ai_access_available(graph.path(), "notes/alias.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn another_process_lease_blocks_until_its_file_lock_is_released() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        let identity = path_lease_identity("notes/a.md");
        let directory = lease_directory(graph.path(), &identity);
        ensure_real_directory(&graph.path().join(".reflect").join("note-owners")).unwrap();
        ensure_real_directory(&directory).unwrap();
        let foreign_path = directory.join("foreign-process.lock");
        let foreign = open_real_lease_file(&foreign_path).unwrap();
        foreign.lock().unwrap();

        graph_fs::with_file_mutation_lock(graph.path(), || {
            assert!(!state.ai_access_available(graph.path(), "notes/a.md", "main", None)?);
            Ok(())
        })
        .unwrap();
        foreign.unlock().unwrap();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            assert!(state.ai_access_available(graph.path(), "notes/a.md", "main", None)?);
            Ok(())
        })
        .unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn a_claim_cannot_interleave_with_an_ai_check_and_disk_read() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let graph = graph();
        fs::write(graph.path().join("notes/a.md"), "# Disk\n").unwrap();
        let root = graph.path().to_path_buf();
        let state = Arc::new(NoteWindowOwnershipState::default());
        let (checked_tx, checked_rx) = mpsc::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let ai_root = root.clone();
        let ai_state = Arc::clone(&state);
        let ai = std::thread::spawn(move || {
            graph_fs::with_file_mutation_lock(&ai_root, || {
                assert!(ai_state.ai_access_available(&ai_root, "notes/a.md", "main", None)?);
                checked_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                assert_eq!(fs::read_to_string(ai_root.join("notes/a.md"))?, "# Disk\n");
                Ok(())
            })
            .unwrap();
        });
        checked_rx.recv().unwrap();

        let (claimed_tx, claimed_rx) = mpsc::channel();
        let claim_root = root.clone();
        let claim_state = Arc::clone(&state);
        let claim = std::thread::spawn(move || {
            graph_fs::with_file_mutation_lock(&claim_root, || {
                claim_state.claim_locked(&claim_root, "notes/a.md", "owner-1", "note-a")
            })
            .unwrap();
            claimed_tx.send(()).unwrap();
        });
        assert!(matches!(
            claimed_rx.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        finish_tx.send(()).unwrap();
        ai.join().unwrap();
        claimed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        claim.join().unwrap();

        graph_fs::with_file_mutation_lock(&root, || {
            assert!(!state.ai_access_available(&root, "notes/a.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn release_requires_the_exact_owner_and_window() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/a.md", "owner-1", "note-a")?;
            state.release_locked("notes/a.md", "owner-1", "main")?;
            assert!(!state.ai_access_available(graph.path(), "notes/a.md", "main", None)?);
            state.release_locked("notes/a.md", "owner-1", "note-a")?;
            assert!(state.ai_access_available(graph.path(), "notes/a.md", "main", None)?);
            Ok(())
        })
        .unwrap();
        assert!(fs::read_dir(graph.path().join(".reflect/note-owners"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn window_cleanup_releases_only_that_webviews_claims() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/a.md", "owner-1", "note-a")?;
            state.claim_locked(graph.path(), "notes/b.md", "owner-2", "note-a")?;
            state.claim_locked(graph.path(), "notes/c.md", "owner-3", "note-b")?;
            Ok(())
        })
        .unwrap();

        release_window(&state, "note-a");
        graph_fs::with_file_mutation_lock(graph.path(), || {
            assert!(state.ai_access_available(graph.path(), "notes/a.md", "main", None)?);
            assert!(state.ai_access_available(graph.path(), "notes/b.md", "main", None)?);
            assert!(!state.ai_access_available(graph.path(), "notes/c.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_case_only_retarget_updates_the_same_owner_claim() {
        let graph = graph();
        let state = NoteWindowOwnershipState::default();
        graph_fs::with_file_mutation_lock(graph.path(), || {
            state.claim_locked(graph.path(), "notes/API.md", "owner-1", "note-a")?;
            state.claim_locked(graph.path(), "notes/api.md", "owner-1", "note-a")?;
            state.release_locked("notes/API.md", "owner-1", "note-a")?;
            assert!(!state.ai_access_available(graph.path(), "notes/api.md", "main", None)?);
            state.release_locked("notes/api.md", "owner-1", "note-a")?;
            assert!(state.ai_access_available(graph.path(), "notes/api.md", "main", None)?);
            Ok(())
        })
        .unwrap();
    }
}
