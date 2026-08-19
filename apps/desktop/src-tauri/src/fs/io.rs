//! Disk primitives: graph bootstrap, atomic writes, and markdown listing.
//!
//! Pure IO — no Tauri state, no path policy (that's [`super::resolve`]). Writes
//! are atomic (temp file + rename) so a crash mid-write can never truncate a
//! note. Temp files are staged under `.reflect/tmp/` — the same volume, so the
//! rename stays atomic, but excluded from cloud sync so a crash-stranded temp
//! can never replicate to another device (Plan 21).

use std::cell::RefCell;
use std::fs::{self, File};
use std::io::Write;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use std::os::raw::c_int;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use reflect_graph_paths::{evicted_logical_path, eviction_placeholder, is_dataless};
use same_file::Handle as FileIdentity;

use crate::error::{AppError, AppResult};
use crate::graph_gitignore;

use super::FileMeta;

/// Serializes native file mutations within this process. A graph-local locked
/// file extends the same critical section across concurrently running Reflect
/// flavors/processes that have the graph open.
static FILE_MUTATION_LOCK: Mutex<()> = Mutex::new(());
// This budget must cover whole-graph Git checkout and merge critical sections,
// not just individual note writes. Keep a finite ceiling so a wedged process
// cannot block every other Reflect flavor indefinitely.
const FILE_MUTATION_LOCK_TIMEOUT: Duration = Duration::from_secs(60);
const FILE_MUTATION_LOCK_RETRY_DELAY: Duration = Duration::from_millis(10);
thread_local! {
    static HELD_FILE_MUTATION_ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

struct ThreadMutationRootGuard;

impl Drop for ThreadMutationRootGuard {
    fn drop(&mut self) {
        HELD_FILE_MUTATION_ROOT.with(|held| *held.borrow_mut() = None);
    }
}

pub(super) fn with_file_mutation_lock<T>(
    root: &Path,
    operation: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    let canonical_root = root.canonicalize()?;
    let nested = HELD_FILE_MUTATION_ROOT.with(|held| held.borrow().clone());
    if let Some(held_root) = nested {
        if held_root != canonical_root {
            return Err(AppError::io(
                "a graph mutation cannot acquire a different graph lock recursively",
            ));
        }
        return operation();
    }
    let root_identity = FileIdentity::from_path(&canonical_root)?;
    let _guard = match FILE_MUTATION_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            // The mutex protects serialization, not mutable state. A panic in
            // one operation drops the OS lock and thread-local root guard, so
            // the next mutation can safely recover instead of permanently
            // disabling every graph write in this process.
            tracing::warn!("recovering poisoned file mutation lock");
            FILE_MUTATION_LOCK.clear_poison();
            poisoned.into_inner()
        }
    };
    let lock_file = open_file_mutation_lock(&canonical_root)?;
    with_opened_file_mutation_lock(root, &canonical_root, root_identity, lock_file, operation)
}

/// Acquire a lock file that was opened against the pre-wait graph, then prove
/// the graph and its reachable lock inode are still the same before mutating.
fn with_opened_file_mutation_lock<T>(
    root: &Path,
    canonical_root: &Path,
    expected_root_identity: FileIdentity,
    lock_file: File,
    operation: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    let expected_lock_identity = FileIdentity::from_file(lock_file.try_clone()?)?;
    lock_file_with_timeout(&lock_file, FILE_MUTATION_LOCK_TIMEOUT)?;
    let lock_is_current = file_mutation_lock_is_current(
        root,
        canonical_root,
        &expected_root_identity,
        &expected_lock_identity,
    );
    // Identity handles are only needed across the wait and validation. Drop
    // them before a graph-delete closure tries to move the directory.
    drop(expected_lock_identity);
    drop(expected_root_identity);
    if !lock_is_current {
        let _ = lock_file.unlock();
        return Err(AppError::io(
            "the graph moved or was replaced while waiting for its mutation lock",
        ));
    }
    HELD_FILE_MUTATION_ROOT.with(|held| *held.borrow_mut() = Some(canonical_root.to_path_buf()));
    let _thread_root = ThreadMutationRootGuard;
    let result = operation();
    let unlock_result = lock_file.unlock();
    match (result, unlock_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn file_mutation_lock_is_current(
    root: &Path,
    canonical_root: &Path,
    expected_root_identity: &FileIdentity,
    expected_lock_identity: &FileIdentity,
) -> bool {
    let Ok(current_root) = root.canonicalize() else {
        return false;
    };
    if current_root != canonical_root {
        return false;
    }
    let Ok(current_root_identity) = FileIdentity::from_path(&current_root) else {
        return false;
    };
    if &current_root_identity != expected_root_identity {
        return false;
    }
    let Ok(Some(current_lock)) = try_open_file_mutation_lock(&current_root) else {
        return false;
    };
    FileIdentity::from_file(current_lock)
        .is_ok_and(|current_lock_identity| &current_lock_identity == expected_lock_identity)
}

fn lock_file_with_timeout(lock_file: &File, timeout: Duration) -> AppResult<()> {
    let started = Instant::now();
    loop {
        match lock_file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                let elapsed = started.elapsed();
                if elapsed >= timeout {
                    return Err(AppError::io(
                        "timed out waiting for another Reflect process to finish writing this graph",
                    ));
                }
                std::thread::sleep(FILE_MUTATION_LOCK_RETRY_DELAY.min(timeout - elapsed));
            }
            Err(error) => {
                return Err(AppError::io(format!(
                    "failed to acquire the graph mutation lock: {error}"
                )))
            }
        }
    }
}

/// Open the persistent advisory-lock inode without accepting a planted
/// symlink. On Apple platforms `O_NOFOLLOW_ANY` makes the final open itself
/// race-free; elsewhere the metadata checks still fail closed for the normal
/// case. The file contains no state and lives below `.reflect/`, so it is
/// neither synced nor watcher-visible.
fn open_file_mutation_lock(root: &Path) -> AppResult<File> {
    let path = root.join(REFLECT_DIR).join("write.lock");
    loop {
        if let Some(file) = try_open_file_mutation_lock(root)? {
            return Ok(file);
        }
        match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

/// Open the currently addressed lock without creating anything. Mutation-lock
/// revalidation uses this so a stale waiter cannot seed a replacement graph.
fn try_open_file_mutation_lock(root: &Path) -> AppResult<Option<File>> {
    let path = root.join(REFLECT_DIR).join("write.lock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let mut options = fs::OpenOptions::new();
            options.read(true).write(true);
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(O_NOFOLLOW_ANY);
            }
            let opened_path = if cfg!(any(target_os = "macos", target_os = "ios")) {
                root.canonicalize()?.join(REFLECT_DIR).join("write.lock")
            } else {
                path.clone()
            };
            let file = match options.open(opened_path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            if !file.metadata()?.is_file() {
                return Err(AppError::traversal(format!(
                    "mutation lock path must be a real file: {}",
                    path.display()
                )));
            }
            Ok(Some(file))
        }
        Ok(_) => Err(AppError::traversal(format!(
            "mutation lock path must be a real file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Lowercase SHA-256 of a note's complete UTF-8 source.
pub(super) fn note_revision(source: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(source.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AtomicRevisionWriteOutcome {
    Written {
        revision: String,
        modified_ms: Option<u64>,
    },
    Stale {
        current_revision: String,
    },
    Contended {
        current_revision: Option<String>,
    },
    Missing,
}

/// One walk's worth of notes and attachments, in desktop `FileMeta` form.
#[derive(Clone, Default)]
pub(super) struct FileCatalog {
    pub notes: Vec<FileMeta>,
    pub attachments: Vec<FileMeta>,
    /// Entries the walk refused or failed to list (unreadable directories,
    /// symlinks, default-pruned trees) — see `reflect_graph_paths::walk_catalog`.
    pub skipped: u32,
}

pub(super) const REFLECT_DIR: &str = ".reflect";
const META_SCHEMA_VERSION: u32 = 1;
pub(super) const TOP_LEVEL_DIRS: [&str; 3] = ["daily", "notes", "assets"];
#[cfg(any(target_os = "macos", target_os = "ios"))]
const APPLE_EXCLUSION_KEYS: [&str; 2] = [
    "NSURLUbiquitousItemIsExcludedFromSyncKey",
    "NSURLIsExcludedFromBackupKey",
];
#[cfg(target_os = "macos")]
const LOCAL_ONLY_XATTRS: [(&str, &[u8]); 2] = [
    ("com.apple.fileprovider.ignore#P", b"1"),
    ("com.dropbox.ignored", b"1"),
];
/// Create the standard graph layout + ignore/meta files (idempotent).
pub(super) fn bootstrap(root: &Path) -> AppResult<()> {
    for dir in TOP_LEVEL_DIRS {
        fs::create_dir_all(root.join(dir))?;
    }
    initialize_runtime(root)?;
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, graph_gitignore::default_contents())?;
    }
    Ok(())
}

/// Initialize only Reflect's rebuildable runtime state for an existing vault.
/// Existing Markdown folders are opened in place; user-facing directories and
/// the root `.gitignore` remain byte-for-byte untouched.
pub(super) fn initialize_runtime(root: &Path) -> AppResult<()> {
    ensure_runtime_directory(root)?;
    // Another Reflect flavor can have this graph open. Never sweep a temp
    // inode while a guarded write has staged it and is about to persist it.
    with_file_mutation_lock(root, || {
        sweep_upload_staging(root);
        Ok(())
    })?;
    mark_dir_local_only(&root.join(REFLECT_DIR));
    ensure_runtime_gitignore(root)?;
    // A backup repo must never ride a file-sync provider: two devices' object
    // stores merging file-by-file is repository corruption (Plan 21). New
    // repos are marked at init (`git::repo`); this covers pre-existing ones.
    // `symlink_metadata` so a planted symlink is never followed into marking
    // something outside the vault.
    let git_dir = root.join(".git");
    if fs::symlink_metadata(&git_dir).is_ok_and(|metadata| metadata.is_dir()) {
        mark_dir_local_only(&git_dir);
    }
    ensure_runtime_meta(root)?;
    Ok(())
}

/// Establish the one directory Reflect is allowed to add when adopting an
/// existing vault. `create_dir_all` follows a pre-existing symlink, which
/// would let an untrusted vault redirect cleanup and metadata writes outside
/// its root; inspect the entry itself and fail closed on every non-directory.
fn ensure_runtime_directory(root: &Path) -> AppResult<()> {
    ensure_real_directory(&root.join(REFLECT_DIR))
}

/// Create one directory component without accepting a pre-existing symlink.
/// The parent must already be a verified real directory.
pub(super) fn ensure_real_directory(path: &Path) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(AppError::traversal(format!(
            "directory path must be a real directory: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A single-component create is intentional: if another process
            // races in a symlink or file, `create_dir` refuses to follow it.
            match fs::create_dir(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    ensure_real_directory(path)
                }
                Err(error) => Err(error.into()),
            }
        }
        Err(error) => Err(error.into()),
    }
}

/// `*` makes `.reflect/` self-ignoring: git never shows a directory whose
/// entire contents are ignored (the pattern uv uses for `.venv/`). One file
/// inside the directory Reflect itself creates covers plain repositories,
/// linked worktrees, submodules, and vaults that are subdirectories of a
/// larger repository — without ever touching `.git`.
fn ensure_runtime_gitignore(root: &Path) -> AppResult<()> {
    create_runtime_file(&root.join(REFLECT_DIR).join(".gitignore"), "*\n")
}

fn ensure_runtime_meta(root: &Path) -> AppResult<()> {
    create_runtime_file(
        &root.join(REFLECT_DIR).join("meta.json"),
        &format!("{{\n  \"schemaVersion\": {META_SCHEMA_VERSION}\n}}\n"),
    )
}

fn create_runtime_file(path: &Path, contents: &str) -> AppResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(AppError::traversal(format!(
            "runtime file path must be a real file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // `create_new` is atomic and refuses even a dangling symlink that
            // races this probe, so the write cannot be redirected.
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            file.write_all(contents.as_bytes())?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

/// `O_NOFOLLOW_ANY` from the macOS SDK's `<sys/fcntl.h>` (also in Apple's
/// open-source XNU): refuse to open when **any** path component is a
/// symlink, atomically — no check-then-use window. Spelled out here because
/// the `libc` crate does not bind it yet.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const O_NOFOLLOW_ANY: i32 = 0x2000_0000;

/// Read a note's markdown with symlink traversal refused at open time on
/// Apple platforms. Symlinks are outside the graph-content contract:
/// discovery never lists them and the watcher reports them as removals; this
/// closes the remaining door — a direct read through a stale route or index
/// row. The root is canonicalized first (a vault may legitimately live
/// *behind* a symlink — `/var`, a linked `~/Dropbox`); `O_NOFOLLOW_ANY` then
/// polices only the components below it. Off Apple targets it falls back to
/// a plain read (the lexical resolve guard still applies).
pub(super) fn read_note_no_follow(root: &Path, abs: &Path) -> std::io::Result<String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let path = match abs.strip_prefix(root) {
            Ok(rel) => root.canonicalize()?.join(rel),
            Err(_) => abs.to_path_buf(),
        };
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(O_NOFOLLOW_ANY)
            .open(path)?;
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        Ok(contents)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = root;
        fs::read_to_string(abs)
    }
}

/// Drop leftover staging files (`.reflect/tmp/`: asset uploads, `fs::assets`,
/// and atomic-write temps) — a crash mid-write strands its temp file, and
/// nothing else ever reclaims it. Opening the graph is the natural sweep
/// point: a generation bump rejects any commit that was still in flight, so
/// nothing live is removed. Best-effort — a locked file must not fail the open.
fn sweep_upload_staging(root: &Path) {
    let staging = root.join(REFLECT_DIR).join("tmp");
    if !staging.exists() {
        return;
    }
    if let Err(err) = fs::remove_dir_all(&staging) {
        tracing::warn!(path = %staging.display(), %err, "failed to sweep upload staging");
    }
}

/// Keep `dir` out of every file-sync pipeline (best-effort, idempotent).
///
/// On Apple targets the `NSURL` resource keys exclude the directory from
/// iCloud Drive sync and device backups — load-bearing once the graph lives in
/// the iCloud container (Plan 21), where `.reflect/` (live SQLite + WAL) and
/// `.git/` syncing would mean corruption. macOS additionally sets the
/// provider-ignore xattrs that third-party sync clients (Dropbox, File
/// Provider extensions) honor for graphs kept in such folders.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) fn mark_dir_local_only(_dir: &Path) {}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn mark_dir_local_only(dir: &Path) {
    for err in set_apple_sync_exclusions(dir) {
        tracing::warn!(
            path = %dir.display(),
            %err,
            "failed to mark directory as excluded from Apple sync"
        );
    }
    #[cfg(target_os = "macos")]
    for err in set_local_only_xattrs(dir) {
        tracing::warn!(
            path = %dir.display(),
            %err,
            "failed to mark directory with provider ignore attributes"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn set_apple_sync_exclusions(dir: &Path) -> Vec<String> {
    use core_foundation::base::TCFType;
    use core_foundation::{number, string, url};
    use std::ptr;

    let Some(dir_url) = url::CFURL::from_path(dir, true) else {
        return vec![format!("invalid path: {}", dir.display())];
    };
    let mut errors = Vec::new();

    for key_name in APPLE_EXCLUSION_KEYS {
        let Ok(key) = key_name.parse::<string::CFString>() else {
            errors.push(format!("invalid resource key: {key_name}"));
            continue;
        };
        let ok = unsafe {
            url::CFURLSetResourcePropertyForKey(
                dir_url.as_concrete_TypeRef(),
                key.as_concrete_TypeRef(),
                number::kCFBooleanTrue as *const _,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            errors.push(format!("failed to set {key_name}"));
        }
    }

    errors
}

#[cfg(target_os = "macos")]
fn set_local_only_xattrs(dir: &Path) -> Vec<String> {
    let mut errors = Vec::new();

    for (name, value) in LOCAL_ONLY_XATTRS {
        if let Err(err) = xattr::set(dir, name, value) {
            errors.push(format!("failed to set {name}: {err}"));
        }
    }

    errors
}

/// Atomically write `contents` to `target` inside the graph at `root`.
/// Returns the persisted file's mtime (see [`atomic_write_bytes`]).
pub(super) fn atomic_write(root: &Path, target: &Path, contents: &str) -> AppResult<Option<u64>> {
    atomic_write_bytes(root, target, contents.as_bytes())
}

/// Compare the complete current source and atomically replace it under the
/// process- and graph-wide mutation lock.
pub(super) fn atomic_write_if_revision(
    root: &Path,
    target: &Path,
    contents: &str,
    expected_revision: &str,
) -> AppResult<AtomicRevisionWriteOutcome> {
    atomic_write_if_revision_with(root, target, contents, expected_revision, || Ok(()))
}

fn atomic_write_if_revision_with(
    root: &Path,
    target: &Path,
    contents: &str,
    expected_revision: &str,
    after_persist: impl FnOnce() -> AppResult<()>,
) -> AppResult<AtomicRevisionWriteOutcome> {
    with_file_mutation_lock(root, || {
        // Stage before the revision check. Nothing watcher-visible changes
        // until the compare has succeeded and this prepared inode is renamed
        // over the note in one operation.
        let staged = stage_bytes(root, target, contents.as_bytes())?;
        let current = match read_note_no_follow(root, target) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AtomicRevisionWriteOutcome::Missing)
            }
            Err(error) => return Err(error.into()),
        };
        let current_revision = note_revision(&current);
        if current_revision != expected_revision {
            return Ok(AtomicRevisionWriteOutcome::Stale { current_revision });
        }
        let modified_ms = persist_staged(staged, target)?;
        after_persist()?;
        let intended_revision = note_revision(contents);
        // Advisory locking coordinates every cooperating Reflect process. A
        // generic filesystem has no portable atomic content-CAS, so another
        // program that ignores the lock can still replace the path. Verify
        // immediately and surface that race as uncertain rather than claiming
        // the intended bytes are current.
        let verified_revision = read_note_no_follow(root, target)
            .ok()
            .map(|source| note_revision(&source));
        if verified_revision.as_deref() != Some(intended_revision.as_str()) {
            return Ok(AtomicRevisionWriteOutcome::Contended {
                current_revision: verified_revision,
            });
        }
        Ok(AtomicRevisionWriteOutcome::Written {
            revision: intended_revision,
            modified_ms,
        })
    })
}

/// Result of an atomic create-if-absent attempt.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AtomicCreateOutcome {
    Created(Option<u64>),
    Collision,
}

/// Atomically create `target` without replacing anything that already owns its
/// path. This is the filesystem claim for note creation: the caller may probe
/// beforehand for policy, but only `persist_noclobber` closes the race with a
/// concurrent sync checkout or another creator.
pub(super) fn atomic_create(
    root: &Path,
    target: &Path,
    contents: &str,
) -> AppResult<AtomicCreateOutcome> {
    with_file_mutation_lock(root, || atomic_create_unlocked(root, target, contents))
}

fn atomic_create_unlocked(
    root: &Path,
    target: &Path,
    contents: &str,
) -> AppResult<AtomicCreateOutcome> {
    // An evicted iCloud note occupies its logical path through the placeholder
    // alone. `persist_noclobber(target)` cannot see that sibling stub, so keep
    // the shared occupancy check in front of the atomic real-file claim.
    if file_occupied(target) {
        return Ok(AtomicCreateOutcome::Collision);
    }
    let temp = stage_bytes(root, target, contents.as_bytes())?;
    match temp.persist_noclobber(target) {
        Ok(file) => Ok(AtomicCreateOutcome::Created(
            file.metadata().ok().as_ref().and_then(modified_ms),
        )),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(AtomicCreateOutcome::Collision)
        }
        Err(error) => Err(AppError::io(error.error.to_string())),
    }
}

/// Byte-level atomic write — shared by notes (text) and assets (binary).
/// Returns the persisted file's mtime in epoch milliseconds (`None` when the
/// platform can't provide one), read from the file handle itself — the index
/// stamps its rows with this so a later listing compares equal and skips the
/// re-read.
///
/// The temp file is staged under `.reflect/tmp/`, not next to `target`: the
/// note directories may live inside a file-sync folder (iCloud Drive —
/// Plan 21), and a temp created there is synced and, after a crash, stranded
/// on every device. `.reflect/` is excluded from sync and swept on graph open,
/// and it shares `target`'s volume, so the final rename stays atomic.
pub(crate) fn atomic_write_bytes(
    root: &Path,
    target: &Path,
    contents: &[u8],
) -> AppResult<Option<u64>> {
    with_file_mutation_lock(root, || atomic_write_bytes_unlocked(root, target, contents))
}

fn atomic_write_bytes_unlocked(
    root: &Path,
    target: &Path,
    contents: &[u8],
) -> AppResult<Option<u64>> {
    let tmp = stage_bytes(root, target, contents)?;
    persist_staged(tmp, target)
}

fn persist_staged(tmp: tempfile::NamedTempFile, target: &Path) -> AppResult<Option<u64>> {
    let file = tmp
        .persist(target)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(file.metadata().ok().as_ref().and_then(modified_ms))
}

/** Stage synced bytes on `target`'s volume, ready for an atomic persist. */
fn stage_bytes(root: &Path, target: &Path, contents: &[u8]) -> AppResult<tempfile::NamedTempFile> {
    let dir = target
        .parent()
        .ok_or_else(|| AppError::io(format!("no parent directory for {}", target.display())))?;
    fs::create_dir_all(dir)?;
    let staging = root.join(REFLECT_DIR).join("tmp");
    fs::create_dir_all(&staging)?;
    let mut tmp = tempfile::NamedTempFile::new_in(&staging)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    Ok(tmp)
}

/// Last-modified time in epoch milliseconds, or `None` when the platform
/// can't provide one. Shared by `list_files` and the watcher so every index
/// path derives mtimes the same way.
pub(crate) fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
}

/// The thread/process I/O policy interface from `<sys/resource.h>`
/// (`getiopolicy_np(3)`, available since macOS 10.5 / iOS 2.0), not bound by
/// the `libc` crate yet. Policy type 3 governs whether file access
/// materializes dataless files (TN3150).
#[cfg(any(target_os = "macos", target_os = "ios"))]
const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES: c_int = 3;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const IOPOL_SCOPE_THREAD: c_int = 1;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const IOPOL_MATERIALIZE_DATALESS_FILES_OFF: c_int = 1;

#[cfg(any(target_os = "macos", target_os = "ios"))]
extern "C" {
    fn getiopolicy_np(iotype: c_int, scope: c_int) -> c_int;
    fn setiopolicy_np(iotype: c_int, scope: c_int, policy: c_int) -> c_int;
}

/// Dataless-file materialization switched **off** for the current thread,
/// RAII (TN3150's second option:
/// <https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files>).
/// While engaged, reading a dataless file fails with `EDEADLK`
/// (`std::io::ErrorKind::Deadlock`) instead of blocking while
/// `fileproviderd` fetches the bytes; `note_read_local` uses this to close
/// its stat-then-read race, reporting an eviction that lands between the
/// check and the read as `Evicted` rather than downloading it. Restoring
/// the previous policy on drop matters: the async runtime's blocking pool
/// reuses threads, and a leaked `OFF` would make every later command on the
/// thread refuse materialization.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) struct NoMaterialize {
    previous: c_int,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl NoMaterialize {
    /// Engage the thread-scoped policy; `None` (and no policy change) when
    /// the kernel refuses. Callers proceed unguarded then: the stat check
    /// still catches settled evictions, only the race window reopens.
    pub(crate) fn engage() -> Option<Self> {
        let previous = unsafe {
            getiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
            )
        };
        if previous < 0 {
            return None;
        }
        let set = unsafe {
            setiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
                IOPOL_MATERIALIZE_DATALESS_FILES_OFF,
            )
        };
        (set == 0).then_some(Self { previous })
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl Drop for NoMaterialize {
    fn drop(&mut self) {
        unsafe {
            setiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
                self.previous,
            );
        }
    }
}

/// No dataless files off Apple platforms; the guard is a no-op.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) struct NoMaterialize;

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
impl NoMaterialize {
    pub(crate) fn engage() -> Option<Self> {
        Some(Self)
    }
}

/// Whether a path is **occupied**: a readable file, or an evicted iCloud note
/// whose placeholder still holds the name. Existence probes that guard
/// against overwriting (the collision picker's `note_exists`, the rename
/// destination check) must use this — an evicted note looks vacant to
/// `is_file()` but comes back the moment iCloud re-downloads it, and anything
/// created in its place becomes a conflict.
pub(crate) fn file_occupied(abs: &Path) -> bool {
    abs.is_file() || eviction_placeholder(abs).is_some_and(|stub| stub.exists())
}

/// Collect files under `root/dir` into `out` (recursive). `extension` filters
/// by file extension when set (`Some("md")` for notes); `None` collects every
/// regular file (assets). An iCloud eviction placeholder lists as its
/// *logical* file (same extension rules) with `placeholder: true`, so an
/// evicted note stays present to reconcile instead of looking deleted.
pub(super) fn collect_files(
    root: &Path,
    dir: &str,
    extension: Option<&str>,
    out: &mut Vec<FileMeta>,
) -> AppResult<()> {
    let base = root.join(dir);
    if !base.is_dir() {
        return Ok(());
    }
    let extension_matches = |path: &Path| {
        extension.is_none_or(|ext| path.extension().and_then(|found| found.to_str()) == Some(ext))
    };
    let mut stack = vec![base];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            // Don't follow symlinks — they can point outside the graph.
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let listed = match evicted_logical_path(&path) {
                // A placeholder stands in for its logical file: apply the
                // extension rules to that file, and drop the stub when the
                // real file is (again) present so a note never lists twice.
                Some(logical) if extension_matches(&logical) && !logical.exists() => {
                    Some((logical, true))
                }
                Some(_) => None,
                None if extension_matches(&path) => Some((path.clone(), false)),
                None => None,
            };
            let Some((listed_path, placeholder)) = listed else {
                continue;
            };
            // Skip anything that isn't actually under the root rather than
            // leaking an absolute path.
            let Ok(rel) = listed_path.strip_prefix(root) else {
                continue;
            };
            let meta = entry.metadata()?;
            out.push(FileMeta {
                path: rel.to_string_lossy().replace('\\', "/"),
                size: meta.len(),
                modified_ms: modified_ms(&meta).unwrap_or(0),
                // Two eviction forms fold into one flag: the legacy `.icloud`
                // stub (detected by name above) and the modern dataless file
                // (kernel flag on the real path).
                placeholder: placeholder || is_dataless(&meta),
            });
        }
    }
    Ok(())
}

/// Recursively list every eligible Markdown note from the graph root, via the
/// shared vault walk (`reflect_graph_paths::walk_catalog`).
pub(super) fn collect_note_files(root: &Path) -> Vec<FileMeta> {
    collect_file_catalog(root).notes
}

/// Build one snapshot of every eligible note and supported attachment.
pub(super) fn collect_file_catalog(root: &Path) -> FileCatalog {
    let catalog = reflect_graph_paths::walk_catalog(root);
    FileCatalog {
        notes: catalog.notes.into_iter().map(file_meta_from).collect(),
        attachments: catalog
            .attachments
            .into_iter()
            .map(file_meta_from)
            .collect(),
        skipped: catalog.skipped,
    }
}

fn file_meta_from(entry: reflect_graph_paths::FileEntry) -> FileMeta {
    FileMeta {
        path: entry.path,
        size: entry.size,
        modified_ms: entry.modified_ms,
        placeholder: entry.placeholder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(target_os = "macos")]
    #[test]
    fn note_reads_refuse_every_symlinked_component() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::create_dir_all(outside.path().join("real")).unwrap();
        fs::write(outside.path().join("real/secret.md"), "# outside").unwrap();
        symlink(
            outside.path().join("real/secret.md"),
            dir.path().join("notes/leaf.md"),
        )
        .unwrap();
        symlink(outside.path().join("real"), dir.path().join("linked")).unwrap();
        fs::write(dir.path().join("notes/plain.md"), "# plain").unwrap();

        let root = dir.path();
        assert!(read_note_no_follow(root, &root.join("notes/leaf.md")).is_err());
        assert!(read_note_no_follow(root, &root.join("linked/secret.md")).is_err());
        assert_eq!(
            read_note_no_follow(root, &root.join("notes/plain.md")).unwrap(),
            "# plain"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn no_materialize_engages_and_restores_the_thread_policy() {
        let current = || unsafe {
            getiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
            )
        };
        let before = current();
        let guard = NoMaterialize::engage().expect("thread policy should engage");
        assert_eq!(current(), IOPOL_MATERIALIZE_DATALESS_FILES_OFF);
        // Restore-on-drop is what keeps the guard safe on the async
        // runtime's reused blocking threads.
        drop(guard);
        assert_eq!(current(), before);
    }

    #[test]
    fn a_local_read_succeeds_under_the_no_materialize_guard() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"hello").unwrap();
        let _no_materialize = NoMaterialize::engage();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn bootstrap_creates_layout() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        for sub in TOP_LEVEL_DIRS {
            assert!(dir.path().join(sub).is_dir(), "missing dir {sub}");
        }
        let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(gitignore.contains("/.reflect/"));
        assert!(gitignore.contains(".DS_Store"));
        assert!(gitignore.contains("Thumbs.db"));
        assert!(gitignore.contains("*.swp"));
        assert!(dir.path().join(".reflect/meta.json").exists());
    }

    #[test]
    fn existing_vault_initialization_adds_runtime_only() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "# Existing\n").unwrap();
        fs::write(dir.path().join(".gitignore"), "node_modules/\n").unwrap();

        initialize_runtime(dir.path()).unwrap();

        assert!(dir.path().join(".reflect/meta.json").is_file());
        assert_eq!(
            fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "node_modules/\n"
        );
        for sub in TOP_LEVEL_DIRS {
            assert!(!dir.path().join(sub).exists(), "unexpected dir {sub}");
        }
        assert_eq!(
            fs::read_to_string(dir.path().join("README.md")).unwrap(),
            "# Existing\n"
        );
    }

    #[test]
    fn runtime_directory_self_ignores_for_any_git_shape() {
        let dir = tempdir().unwrap();
        initialize_runtime(dir.path()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(".reflect/.gitignore")).unwrap(),
            "*\n"
        );
    }

    #[test]
    fn adopted_repository_ignores_and_never_stages_runtime_state() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("note.md"), "# Note\n").unwrap();

        initialize_runtime(dir.path()).unwrap();
        fs::write(dir.path().join(".reflect/index.sqlite"), b"db").unwrap();

        // The self-ignoring `.reflect/.gitignore` makes every runtime file
        // ignored — `git status` (CLI) shows nothing for the directory, and
        // the backup's `add_all` can never stage it.
        assert!(repo.is_path_ignored(".reflect/index.sqlite").unwrap());
        assert!(repo.is_path_ignored(".reflect/.gitignore").unwrap());
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        let staged: Vec<String> = index
            .iter()
            .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
            .collect();
        assert_eq!(staged, vec!["note.md".to_string()]);
        // (The git CLI hides a directory whose entire contents are ignored,
        // so `git status` shows nothing for `.reflect/`. libgit2's *status
        // listing* is known to diverge cosmetically on such directories, but
        // its ignore machinery and staging — asserted above — do not.)
    }

    #[test]
    fn vaults_with_unusual_git_entries_still_open() {
        // A submodule work tree (`.git` is a file), a broken `.git`, or a
        // separate git dir must never block adopting the folder — the runtime
        // exclusion never touches `.git` at all.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".git"), "gitdir: /nonexistent\n").unwrap();
        initialize_runtime(dir.path()).unwrap();
        assert!(dir.path().join(".reflect/meta.json").is_file());
    }

    #[test]
    fn existing_non_directory_runtime_path_is_rejected_unchanged() {
        let vault = tempdir().unwrap();
        let runtime = vault.path().join(REFLECT_DIR);
        fs::write(&runtime, b"not a directory").unwrap();

        assert!(initialize_runtime(vault.path()).is_err());

        assert_eq!(fs::read(runtime).unwrap(), b"not a directory");
    }

    #[cfg(unix)]
    #[test]
    fn existing_symlinked_runtime_path_is_rejected_before_cleanup_or_write() {
        use std::os::unix::fs::symlink;

        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(outside.path().join("tmp")).unwrap();
        let sentinel = outside.path().join("tmp/keep");
        fs::write(&sentinel, b"outside").unwrap();
        symlink(outside.path(), vault.path().join(REFLECT_DIR)).unwrap();

        assert!(initialize_runtime(vault.path()).is_err());

        assert_eq!(fs::read(sentinel).unwrap(), b"outside");
        assert!(!outside.path().join("meta.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_runtime_metadata_is_never_created_outside_the_vault() {
        use std::os::unix::fs::symlink;

        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(vault.path().join(REFLECT_DIR)).unwrap();
        let outside_meta = outside.path().join("meta.json");
        symlink(
            &outside_meta,
            vault.path().join(REFLECT_DIR).join("meta.json"),
        )
        .unwrap();

        assert!(initialize_runtime(vault.path()).is_err());
        assert!(!outside_meta.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bootstrap_marks_reflect_dir_with_provider_ignore_xattrs() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let reflect_dir = dir.path().join(REFLECT_DIR);
        assert_eq!(
            xattr::get(&reflect_dir, "com.apple.fileprovider.ignore#P").unwrap(),
            Some(b"1".to_vec())
        );
        assert_eq!(
            xattr::get(&reflect_dir, "com.dropbox.ignored").unwrap(),
            Some(b"1".to_vec())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bootstrap_marks_a_present_git_dir_local_only() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        bootstrap(dir.path()).unwrap();
        assert_eq!(
            xattr::get(dir.path().join(".git"), "com.apple.fileprovider.ignore#P").unwrap(),
            Some(b"1".to_vec())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_sync_exclusion_accepts_reflect_dir() {
        let dir = tempdir().unwrap();
        let reflect_dir = dir.path().join(REFLECT_DIR);
        fs::create_dir_all(&reflect_dir).unwrap();
        assert!(set_apple_sync_exclusions(&reflect_dir).is_empty());
    }

    #[test]
    fn bootstrap_sweeps_stale_upload_staging() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let staging = dir.path().join(".reflect/tmp");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join(".tmpAbC123"), b"stranded upload").unwrap();
        // Re-opening the graph re-bootstraps; the stranded file goes away.
        bootstrap(dir.path()).unwrap();
        assert!(!staging.exists());
    }

    #[test]
    fn atomic_write_round_trips() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/hello.md");
        atomic_write(dir.path(), &target, "# Hello\n\nworld\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Hello\n\nworld\n");
    }

    #[test]
    fn revision_guarded_write_rejects_stale_and_missing_sources() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/hello.md");

        assert_eq!(
            atomic_write_if_revision(dir.path(), &target, "new", "missing").unwrap(),
            AtomicRevisionWriteOutcome::Missing
        );
        atomic_write(dir.path(), &target, "# Original\n").unwrap();
        let stale = atomic_write_if_revision(dir.path(), &target, "# New\n", "wrong").unwrap();
        assert_eq!(
            stale,
            AtomicRevisionWriteOutcome::Stale {
                current_revision: note_revision("# Original\n")
            }
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Original\n");
    }

    #[test]
    fn revision_guarded_write_replaces_the_complete_matching_source() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/hello.md");
        let original = "---\nid: 01ABC\n---\n# Hello\n\nOld\n";
        let replacement = "---\nid: 01ABC\n---\n# Hello\n\nNew\n";
        atomic_write(dir.path(), &target, original).unwrap();

        let outcome =
            atomic_write_if_revision(dir.path(), &target, replacement, &note_revision(original))
                .unwrap();
        assert!(matches!(
            outcome,
            AtomicRevisionWriteOutcome::Written { revision, .. }
                if revision == note_revision(replacement)
        ));
        assert_eq!(fs::read_to_string(target).unwrap(), replacement);
    }

    #[test]
    fn revision_guarded_write_reports_a_noncooperating_post_persist_race() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/hello.md");
        atomic_write(dir.path(), &target, "original").unwrap();

        let outcome = atomic_write_if_revision_with(
            dir.path(),
            &target,
            "intended",
            &note_revision("original"),
            || {
                // Deliberately bypass the advisory lock: this is the external
                // editor/file-provider race the post-persist check detects.
                fs::write(&target, "external")?;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            outcome,
            AtomicRevisionWriteOutcome::Contended {
                current_revision: Some(note_revision("external"))
            }
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "external");
    }

    #[test]
    fn cross_process_mutation_lock_serializes_revision_guards() {
        const TEST_NAME: &str =
            "fs::io::tests::cross_process_mutation_lock_serializes_revision_guards";
        const ROLE: &str = "REFLECT_FILE_LOCK_TEST_CHILD";
        const ROOT: &str = "REFLECT_FILE_LOCK_TEST_ROOT";

        let wait_for = |path: &Path| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !path.exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "timed out waiting for {path:?}"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };

        if std::env::var_os(ROLE).is_some() {
            let root = PathBuf::from(std::env::var_os(ROOT).expect("child root"));
            let locked = root.join("child-locked");
            let release = root.join("release-child");
            with_file_mutation_lock(&root, || {
                fs::write(&locked, b"")?;
                wait_for(&release);
                atomic_write_bytes_unlocked(&root, &root.join("notes/a.md"), b"child")?;
                Ok(())
            })
            .unwrap();
            return;
        }

        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/a.md");
        atomic_write(dir.path(), &target, "original").unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(ROLE, "1")
            .env(ROOT, dir.path())
            .spawn()
            .unwrap();
        wait_for(&dir.path().join("child-locked"));

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let root = dir.path().to_path_buf();
        let expected = note_revision("original");
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result =
                atomic_write_if_revision(&root, &root.join("notes/a.md"), "parent", &expected);
            result_tx.send(result).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(matches!(
            result_rx.recv_timeout(std::time::Duration::from_millis(150)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        fs::write(dir.path().join("release-child"), b"").unwrap();
        let status = child.wait().unwrap();
        assert!(status.success(), "child lock process failed: {status}");
        let outcome = result_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
        assert_eq!(
            outcome,
            AtomicRevisionWriteOutcome::Stale {
                current_revision: note_revision("child")
            }
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "child");
    }

    #[test]
    fn mutation_lock_wait_is_bounded() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("lock");
        let holder = File::create(&path).unwrap();
        let contender = File::options().read(true).write(true).open(path).unwrap();
        holder.lock().unwrap();

        let started = Instant::now();
        let error = lock_file_with_timeout(&contender, Duration::from_millis(30)).unwrap_err();
        let elapsed = started.elapsed();
        holder.unlock().unwrap();

        assert!(elapsed >= Duration::from_millis(30));
        assert!(elapsed < Duration::from_secs(1));
        assert!(matches!(
            error,
            AppError::Io { message } if message.contains("timed out waiting")
        ));
        assert_eq!(FILE_MUTATION_LOCK_TIMEOUT, Duration::from_secs(60));
    }

    #[test]
    fn mutation_lock_refuses_a_graph_moved_while_waiting() {
        let parent = tempdir().unwrap();
        let root = parent.path().join("graph");
        bootstrap(&root).unwrap();
        fs::write(root.join("notes/sentinel.md"), "original").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let root_identity = FileIdentity::from_path(&canonical_root).unwrap();
        let lock_file = open_file_mutation_lock(&canonical_root).unwrap();
        let trashed = parent.path().join("trashed");
        fs::rename(&root, &trashed).unwrap();

        let mut closure_ran = false;
        let result = with_opened_file_mutation_lock(
            &root,
            &canonical_root,
            root_identity,
            lock_file,
            || {
                closure_ran = true;
                fs::create_dir_all(root.join("notes"))?;
                fs::write(root.join("notes/resurrected.md"), "resurrected")?;
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(AppError::Io { message }) if message.contains("moved or was replaced")
        ));
        assert!(!closure_ran);
        assert!(!root.exists());
        assert_eq!(
            fs::read_to_string(trashed.join("notes/sentinel.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn mutation_lock_refuses_a_replacement_graph_at_the_same_path() {
        let parent = tempdir().unwrap();
        let root = parent.path().join("graph");
        bootstrap(&root).unwrap();
        fs::write(root.join("notes/original.md"), "original").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let root_identity = FileIdentity::from_path(&canonical_root).unwrap();
        let lock_file = open_file_mutation_lock(&canonical_root).unwrap();
        let moved = parent.path().join("moved");
        fs::rename(&root, &moved).unwrap();
        bootstrap(&root).unwrap();
        fs::write(root.join("notes/replacement.md"), "replacement").unwrap();

        let mut closure_ran = false;
        let result = with_opened_file_mutation_lock(
            &root,
            &canonical_root,
            root_identity,
            lock_file,
            || {
                closure_ran = true;
                fs::write(root.join("notes/resurrected.md"), "resurrected")?;
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(AppError::Io { message }) if message.contains("moved or was replaced")
        ));
        assert!(!closure_ran);
        assert!(!root.join("notes/resurrected.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("notes/replacement.md")).unwrap(),
            "replacement"
        );
        assert_eq!(
            fs::read_to_string(moved.join("notes/original.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn mutation_lock_refuses_a_replaced_lock_inode() {
        let root = tempdir().unwrap();
        bootstrap(root.path()).unwrap();
        let canonical_root = root.path().canonicalize().unwrap();
        let root_identity = FileIdentity::from_path(&canonical_root).unwrap();
        let lock_file = open_file_mutation_lock(&canonical_root).unwrap();
        let lock_path = canonical_root.join(REFLECT_DIR).join("write.lock");
        fs::rename(
            &lock_path,
            canonical_root.join(REFLECT_DIR).join("old-write.lock"),
        )
        .unwrap();
        File::create(&lock_path).unwrap();

        let mut closure_ran = false;
        let result = with_opened_file_mutation_lock(
            root.path(),
            &canonical_root,
            root_identity,
            lock_file,
            || {
                closure_ran = true;
                fs::write(root.path().join("notes/mutated.md"), "mutated")?;
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(AppError::Io { message }) if message.contains("moved or was replaced")
        ));
        assert!(!closure_ran);
        assert!(!root.path().join("notes/mutated.md").exists());
    }

    #[test]
    fn process_mutation_lock_recovers_after_a_panicking_operation() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();

        let panic = std::panic::catch_unwind(|| {
            let _ = with_file_mutation_lock(dir.path(), || -> AppResult<()> {
                panic!("intentional mutation panic");
            });
        });
        assert!(panic.is_err());

        let mut nested_ran = false;
        with_file_mutation_lock(dir.path(), || {
            with_file_mutation_lock(dir.path(), || {
                nested_ran = true;
                Ok(())
            })
        })
        .unwrap();
        assert!(nested_ran);
    }

    #[test]
    fn atomic_write_leaves_no_temp_litter_in_the_target_dir() {
        // Temps stage under `.reflect/tmp/` — a note directory inside a synced
        // folder must only ever contain the notes themselves.
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/a.md"), "a").unwrap();
        let entries: Vec<String> = fs::read_dir(dir.path().join("notes"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["a.md".to_string()]);
        assert!(dir.path().join(".reflect/tmp").is_dir());
    }

    #[test]
    fn atomic_create_reports_collision_without_overwriting() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/business-ideas.md");

        assert!(matches!(
            atomic_create(dir.path(), &target, "# First\n").unwrap(),
            AtomicCreateOutcome::Created(_)
        ));
        assert_eq!(
            atomic_create(dir.path(), &target, "# Replacement\n").unwrap(),
            AtomicCreateOutcome::Collision
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "# First\n");
    }

    #[test]
    fn atomic_create_allows_exactly_one_concurrent_claim() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let root = Arc::new(dir.path().to_path_buf());
        let barrier = Arc::new(Barrier::new(2));

        let claim = |contents: &'static str| {
            let root = Arc::clone(&root);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let target = root.join("notes/business-ideas.md");
                barrier.wait();
                (contents, atomic_create(&root, &target, contents).unwrap())
            })
        };
        let first = claim("# First\n");
        let second = claim("# Second\n");
        let outcomes = [first.join().unwrap(), second.join().unwrap()];

        assert_eq!(
            outcomes
                .iter()
                .filter(|(_, outcome)| matches!(outcome, AtomicCreateOutcome::Created(_)))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|(_, outcome)| matches!(outcome, AtomicCreateOutcome::Collision))
                .count(),
            1
        );
        let winner = outcomes
            .iter()
            .find_map(|(contents, outcome)| {
                matches!(outcome, AtomicCreateOutcome::Created(_)).then_some(*contents)
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("notes/business-ideas.md")).unwrap(),
            winner
        );
    }

    #[test]
    fn atomic_create_treats_an_eviction_placeholder_as_a_collision() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/business-ideas.md");
        let placeholder = dir.path().join("notes/.business-ideas.md.icloud");
        fs::write(&placeholder, b"stub").unwrap();

        assert_eq!(
            atomic_create(dir.path(), &target, "# Replacement\n").unwrap(),
            AtomicCreateOutcome::Collision
        );
        assert!(!target.exists());
        assert_eq!(fs::read(placeholder).unwrap(), b"stub");
    }

    #[test]
    fn note_walk_finds_root_and_nested_markdown_and_prunes_reserved_hidden_paths() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/a.md"), "a").unwrap();
        atomic_write(dir.path(), &dir.path().join("daily/2026-06-09.md"), "b").unwrap();
        atomic_write(dir.path(), &dir.path().join("templates/journal.md"), "t").unwrap();
        atomic_write(dir.path(), &dir.path().join("README.md"), "root").unwrap();
        atomic_write(dir.path(), &dir.path().join("Projects/deep/plan.md"), "n").unwrap();
        atomic_write(dir.path(), &dir.path().join("assets/caption.md"), "asset").unwrap();
        atomic_write(dir.path(), &dir.path().join(".obsidian/plugin.md"), "h").unwrap();
        atomic_write(dir.path(), &dir.path().join("Projects/upper.MD"), "u").unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/skip.txt"), "c").unwrap();

        let out = collect_note_files(dir.path());
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"Projects/deep/plan.md"));
        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"daily/2026-06-09.md"));
        assert!(paths.contains(&"templates/journal.md"));
        assert!(!paths.iter().any(|p| p.ends_with(".txt")));
        assert!(!paths.iter().any(|p| p.starts_with("assets/")));
        assert!(!paths.iter().any(|p| p.contains("/.")));
        assert!(!paths.iter().any(|p| p.ends_with(".MD")));
    }

    #[test]
    fn file_catalog_lists_attachments_apart_from_notes() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/a.md"), "a").unwrap();
        atomic_write_bytes(dir.path(), &dir.path().join("assets/photo.png"), b"png").unwrap();
        atomic_write_bytes(dir.path(), &dir.path().join("Media/clip.MP4"), b"video").unwrap();

        let catalog = collect_file_catalog(dir.path());
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        let attachments: Vec<&str> = catalog
            .attachments
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(notes, vec!["notes/a.md"]);
        assert_eq!(attachments, vec!["Media/clip.MP4", "assets/photo.png"]);
    }

    #[test]
    fn evicted_placeholders_list_as_their_logical_note() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        fs::write(dir.path().join("notes/.a.md.icloud"), b"stub").unwrap();

        let mut out = Vec::new();
        collect_files(dir.path(), "notes", Some("md"), &mut out).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "notes/a.md");
        assert!(out[0].placeholder);
    }

    #[test]
    fn placeholders_are_skipped_when_the_real_file_exists() {
        // Transiently both can exist mid-download; the readable file wins and
        // the listing must not carry the same note twice.
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/a.md"), "a").unwrap();
        fs::write(dir.path().join("notes/.a.md.icloud"), b"stub").unwrap();

        let mut out = Vec::new();
        collect_files(dir.path(), "notes", Some("md"), &mut out).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "notes/a.md");
        assert!(!out[0].placeholder);
    }

    #[test]
    fn placeholders_respect_the_extension_filter() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        fs::write(dir.path().join("notes/.data.txt.icloud"), b"stub").unwrap();

        let mut out = Vec::new();
        collect_files(dir.path(), "notes", Some("md"), &mut out).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn occupied_sees_real_files_and_eviction_stubs() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let logical = dir.path().join("notes/a.md");
        assert!(!file_occupied(&logical));
        // An evicted note holds its name through the placeholder alone…
        fs::write(dir.path().join("notes/.a.md.icloud"), b"stub").unwrap();
        assert!(file_occupied(&logical));
        // …and a downloaded note is occupied the ordinary way.
        fs::remove_file(dir.path().join("notes/.a.md.icloud")).unwrap();
        atomic_write(dir.path(), &logical, "# A\n").unwrap();
        assert!(file_occupied(&logical));
    }

    #[test]
    fn unfiltered_collect_lists_every_file_in_a_dir() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        // `audio-memos/` is not bootstrapped — the first write creates it.
        atomic_write_bytes(
            dir.path(),
            &dir.path().join("audio-memos/memo.webm"),
            b"audio",
        )
        .unwrap();
        atomic_write_bytes(
            dir.path(),
            &dir.path().join("audio-memos/memo.m4a"),
            b"audio",
        )
        .unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/a.md"), "a").unwrap();

        let mut out = Vec::new();
        collect_files(dir.path(), "audio-memos", None, &mut out).unwrap();
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths.len(), 2);
        assert!(paths.contains(&"audio-memos/memo.webm"));
        assert!(paths.contains(&"audio-memos/memo.m4a"));
    }

    #[test]
    fn collect_of_a_missing_dir_lists_empty() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();

        let mut out = Vec::new();
        collect_files(dir.path(), "audio-memos", None, &mut out).unwrap();
        assert!(out.is_empty());
    }
}
