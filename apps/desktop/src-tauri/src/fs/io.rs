//! Disk primitives: graph bootstrap, atomic writes, and markdown listing.
//!
//! Pure IO — no Tauri state, no path policy (that's [`super::resolve`]). Writes
//! are atomic (temp file + rename) so a crash mid-write can never truncate a
//! note. Temp files are staged under `.reflect/tmp/` — the same volume, so the
//! rename stays atomic, but excluded from cloud sync so a crash-stranded temp
//! can never replicate to another device (Plan 21).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions};
use same_file::Handle;

#[cfg(test)]
use reflect_graph_paths::icloud_placeholder_target;
use reflect_graph_paths::{evicted_logical_path, eviction_placeholder};

use crate::error::{AppError, AppResult};
use crate::graph_gitignore;

use super::{FileMeta, PinnedGraphRoot};

#[derive(Clone, Default)]
pub(super) struct FileCatalog {
    pub notes: Vec<FileMeta>,
    pub attachments: Vec<FileMeta>,
}

pub(super) const REFLECT_DIR: &str = ".reflect";
static MUTATION_COMMIT_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn lock_mutation_commit() -> AppResult<MutexGuard<'static, ()>> {
    MUTATION_COMMIT_LOCK
        .lock()
        .map_err(|_| AppError::io("filesystem mutation commit lock is poisoned"))
}

#[cfg(test)]
pub(super) fn mutation_commit_lock_is_held_for_test() -> bool {
    match MUTATION_COMMIT_LOCK.try_lock() {
        Ok(guard) => {
            drop(guard);
            false
        }
        Err(std::sync::TryLockError::WouldBlock) => true,
        Err(std::sync::TryLockError::Poisoned(_)) => true,
    }
}

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
    sweep_upload_staging(root);
    mark_dir_local_only(&root.join(REFLECT_DIR));
    // Validate/install the repository-local exclusion before touching `.git`:
    // an adopted vault may contain a hostile symlink there, and even a
    // best-effort xattr write must not follow it outside the vault.
    graph_gitignore::ensure_runtime_excluded(root)?;
    // A backup repo must never ride a file-sync provider: two devices' object
    // stores merging file-by-file is repository corruption (Plan 21). New
    // repos are marked at init (`git::repo`); this covers pre-existing ones.
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
    let runtime = root.join(REFLECT_DIR);
    match fs::symlink_metadata(&runtime) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(AppError::traversal(format!(
            "runtime path must be a real directory: {}",
            runtime.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // The graph root already exists. A single-component create is
            // intentional: if another process races in a symlink or file,
            // `create_dir` fails instead of accepting and following it.
            fs::create_dir(&runtime)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn ensure_runtime_meta(root: &Path) -> AppResult<()> {
    let meta = root.join(REFLECT_DIR).join("meta.json");
    match fs::symlink_metadata(&meta) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(AppError::traversal(format!(
            "runtime metadata path must be a real file: {}",
            meta.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // `create_new` is atomic and refuses even a dangling symlink that
            // races this probe, so metadata creation cannot be redirected.
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&meta)?;
            write!(file, "{{\n  \"schemaVersion\": {META_SCHEMA_VERSION}\n}}\n")?;
            Ok(())
        }
        Err(error) => Err(error.into()),
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
#[cfg(test)]
pub(super) fn atomic_write(root: &Path, target: &Path, contents: &str) -> AppResult<Option<u64>> {
    atomic_write_bytes(root, target, contents.as_bytes())
}

/// Result of an atomic create-if-absent attempt.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AtomicCreateOutcome {
    Created(Option<u64>),
    Collision,
}

/// Result of an optimistic conditional note write.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AtomicConditionalWriteOutcome {
    Written(Option<u64>),
    Changed,
}

/// Atomically create `target` without replacing anything that already owns its
/// path. This is the filesystem claim for note creation: the caller may probe
/// beforehand for policy, but only `persist_noclobber` closes the race with a
/// concurrent sync checkout or another creator.
#[cfg(test)]
pub(super) fn atomic_create(
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
    let _commit_guard = lock_mutation_commit()?;
    if file_occupied(target) {
        return Ok(AtomicCreateOutcome::Collision);
    }
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

/// Optimistically write when the current file bytes match `expected`. `None`
/// means the path is expected to be absent and uses the no-clobber create
/// primitive. Mutations through these IO primitives serialize final validation
/// and replacement; any writer that does not share that lock can still write
/// during the final filesystem-persist window.
#[cfg(test)]
pub(super) fn atomic_write_if_unchanged(
    root: &Path,
    target: &Path,
    expected: Option<&str>,
    contents: &str,
) -> AppResult<AtomicConditionalWriteOutcome> {
    let Some(expected) = expected else {
        return match atomic_create(root, target, contents)? {
            AtomicCreateOutcome::Created(modified_ms) => {
                Ok(AtomicConditionalWriteOutcome::Written(modified_ms))
            }
            AtomicCreateOutcome::Collision => Ok(AtomicConditionalWriteOutcome::Changed),
        };
    };
    let current = match fs::read_to_string(target) {
        Ok(current) => current,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AtomicConditionalWriteOutcome::Changed);
        }
        Err(error) => return Err(error.into()),
    };
    if current != expected {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    }
    let temp = stage_bytes(root, target, contents.as_bytes())?;
    let _commit_guard = lock_mutation_commit()?;
    let current = match fs::read_to_string(target) {
        Ok(current) => current,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AtomicConditionalWriteOutcome::Changed);
        }
        Err(error) => return Err(error.into()),
    };
    if current != expected {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    }
    let file = temp
        .persist(target)
        .map_err(|error| AppError::io(error.to_string()))?;
    Ok(AtomicConditionalWriteOutcome::Written(
        file.metadata().ok().as_ref().and_then(modified_ms),
    ))
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
    let tmp = stage_bytes(root, target, contents)?;
    let _commit_guard = lock_mutation_commit()?;
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

/// Atomically write text through the generation-pinned graph capability.
///
/// The target parent and `.reflect/tmp` are opened component-by-component
/// without following symlinks. The target parent is then reopened from the
/// pinned root immediately before the descriptor-relative rename, so a
/// descendant directory swap fails closed instead of publishing into a
/// detached directory.
pub(super) fn atomic_write_pinned(
    root: &PinnedGraphRoot,
    path: &str,
    contents: &str,
) -> AppResult<Option<u64>> {
    atomic_write_bytes_pinned(root, path, contents.as_bytes())
}

/// Byte-level form of [`atomic_write_pinned`], used by asset writes.
pub(super) fn atomic_write_bytes_pinned(
    root: &PinnedGraphRoot,
    path: &str,
    contents: &[u8],
) -> AppResult<Option<u64>> {
    atomic_write_bytes_pinned_with(root, path, contents, || {})
}

fn atomic_write_bytes_pinned_with<F>(
    root: &PinnedGraphRoot,
    path: &str,
    contents: &[u8],
    before_commit: F,
) -> AppResult<Option<u64>>
where
    F: FnOnce(),
{
    super::ensure_pinned_root_path_identity(root)?;
    let parent = open_visible_parent(root, path, true)?;
    ensure_replaceable_target(&parent.directory, &parent.file_name, path)?;
    let mut staged = stage_pinned_bytes(root, contents)?;

    let _commit_guard = lock_mutation_commit()?;
    before_commit();
    revalidate_visible_parent(root, &parent)?;
    ensure_replaceable_target(&parent.directory, &parent.file_name, path)?;
    staged
        .directory
        .rename(&staged.file_name, &parent.directory, &parent.file_name)
        .map_err(|error| safe_mutation_error(path, error))?;
    staged.published = true;
    Ok(staged
        .file
        .metadata()
        .ok()
        .as_ref()
        .and_then(cap_modified_ms))
}

/// Atomically claim a previously absent path through the pinned capability.
/// The no-replace rename is the final filesystem arbitration; probes are only
/// early exits and never authorize an overwriting rename.
pub(super) fn atomic_create_pinned(
    root: &PinnedGraphRoot,
    path: &str,
    contents: &str,
) -> AppResult<AtomicCreateOutcome> {
    atomic_create_pinned_with(root, path, contents, || {})
}

fn atomic_create_pinned_with<F>(
    root: &PinnedGraphRoot,
    path: &str,
    contents: &str,
    before_commit: F,
) -> AppResult<AtomicCreateOutcome>
where
    F: FnOnce(),
{
    super::ensure_pinned_root_path_identity(root)?;
    let parent = open_visible_parent(root, path, true)?;
    if visible_path_occupied(&parent.directory, &parent.file_name)? {
        return Ok(AtomicCreateOutcome::Collision);
    }
    let mut staged = stage_pinned_bytes(root, contents.as_bytes())?;

    let _commit_guard = lock_mutation_commit()?;
    before_commit();
    revalidate_visible_parent(root, &parent)?;
    if visible_path_occupied(&parent.directory, &parent.file_name)? {
        return Ok(AtomicCreateOutcome::Collision);
    }
    match rename_noreplace(
        &staged.directory,
        &staged.file_name,
        &parent.directory,
        &parent.file_name,
    ) {
        Ok(()) => {
            staged.published = true;
            // The iCloud stub is a sibling name, so the exclusive rename can
            // arbitrate only the real path. Close a placeholder race by
            // returning our just-published inode to staging before reporting
            // the collision.
            if placeholder_exists(&parent.directory, &parent.file_name)? {
                reclaim_published_stage(&mut staged, &parent, path)?;
                return Ok(AtomicCreateOutcome::Collision);
            }
            Ok(AtomicCreateOutcome::Created(
                staged
                    .file
                    .metadata()
                    .ok()
                    .as_ref()
                    .and_then(cap_modified_ms),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(AtomicCreateOutcome::Collision)
        }
        Err(error) => Err(safe_mutation_error(path, error)),
    }
}

/// Optimistically compare the addressed file with `expected`, then atomically
/// replace it after a final identity-and-bytes validation. Mutations through
/// these IO primitives share a commit lock, so they cannot enter between
/// validation and rename. Any writer that does not share the lock can still
/// race the final rename; watcher reconciliation remains authoritative.
pub(super) fn atomic_write_if_unchanged_pinned(
    root: &PinnedGraphRoot,
    path: &str,
    expected: Option<&str>,
    contents: &str,
) -> AppResult<AtomicConditionalWriteOutcome> {
    atomic_write_if_unchanged_pinned_with(root, path, expected, contents, || {})
}

fn atomic_write_if_unchanged_pinned_with<F>(
    root: &PinnedGraphRoot,
    path: &str,
    expected: Option<&str>,
    contents: &str,
    before_commit: F,
) -> AppResult<AtomicConditionalWriteOutcome>
where
    F: FnOnce(),
{
    let Some(expected) = expected else {
        return match atomic_create_pinned_with(root, path, contents, before_commit)? {
            AtomicCreateOutcome::Created(modified_ms) => {
                Ok(AtomicConditionalWriteOutcome::Written(modified_ms))
            }
            AtomicCreateOutcome::Collision => Ok(AtomicConditionalWriteOutcome::Changed),
        };
    };

    super::ensure_pinned_root_path_identity(root)?;
    let parent = match open_visible_parent(root, path, false) {
        Ok(parent) => parent,
        Err(AppError::NotFound { .. }) => return Ok(AtomicConditionalWriteOutcome::Changed),
        Err(error) => return Err(error),
    };
    let Some(mut original) = open_regular_file(&parent.directory, &parent.file_name, path)? else {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    };
    let original_identity = file_identity(&original)?;
    let mut original_contents = String::new();
    original.read_to_string(&mut original_contents)?;
    if original_contents != expected {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    }
    let mut staged = stage_pinned_bytes(root, contents.as_bytes())?;

    let _commit_guard = lock_mutation_commit()?;
    before_commit();
    revalidate_visible_parent(root, &parent)?;
    if placeholder_exists(&parent.directory, &parent.file_name)? {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    }
    let Some(mut current) = open_regular_file(&parent.directory, &parent.file_name, path)? else {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    };
    if file_identity(&current)? != original_identity {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    }
    let mut current_contents = String::new();
    current.read_to_string(&mut current_contents)?;
    if current_contents != expected {
        return Ok(AtomicConditionalWriteOutcome::Changed);
    }

    staged
        .directory
        .rename(&staged.file_name, &parent.directory, &parent.file_name)
        .map_err(|error| safe_mutation_error(path, error))?;
    staged.published = true;
    Ok(AtomicConditionalWriteOutcome::Written(
        staged
            .file
            .metadata()
            .ok()
            .as_ref()
            .and_then(cap_modified_ms),
    ))
}

/// Atomically move one visible regular file without replacing a destination
/// that appeared after an earlier collision probe.
pub(super) fn move_file_pinned(root: &PinnedGraphRoot, from: &str, to: &str) -> AppResult<()> {
    move_file_pinned_with(root, from, to, || {})
}

fn move_file_pinned_with<F>(
    root: &PinnedGraphRoot,
    from: &str,
    to: &str,
    before_commit: F,
) -> AppResult<()>
where
    F: FnOnce(),
{
    super::ensure_pinned_root_path_identity(root)?;
    let source_parent = open_visible_parent(root, from, false)?;
    let destination_parent = open_visible_parent(root, to, true)?;
    let source = open_regular_file(&source_parent.directory, &source_parent.file_name, from)?
        .ok_or_else(|| AppError::not_found(format!("note not found: {from}")))?;
    let source_identity = file_identity(&source)?;
    if visible_path_occupied(&destination_parent.directory, &destination_parent.file_name)? {
        return Err(AppError::io(format!(
            "cannot move note: {to} already exists on disk"
        )));
    }

    let _commit_guard = lock_mutation_commit()?;
    before_commit();
    revalidate_visible_parent(root, &source_parent)?;
    revalidate_visible_parent(root, &destination_parent)?;
    let current_source =
        open_regular_file(&source_parent.directory, &source_parent.file_name, from)?
            .ok_or_else(|| AppError::not_found(format!("note not found: {from}")))?;
    if file_identity(&current_source)? != source_identity {
        return Err(AppError::io(format!(
            "cannot move note: {from} changed before the move committed"
        )));
    }
    if visible_path_occupied(&destination_parent.directory, &destination_parent.file_name)? {
        return Err(AppError::io(format!(
            "cannot move note: {to} already exists on disk"
        )));
    }

    rename_noreplace(
        &source_parent.directory,
        &source_parent.file_name,
        &destination_parent.directory,
        &destination_parent.file_name,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::io(format!("cannot move note: {to} already exists on disk"))
        } else {
            safe_mutation_error(to, error)
        }
    })?;

    let moved = open_regular_file(
        &destination_parent.directory,
        &destination_parent.file_name,
        to,
    )?
    .ok_or_else(|| AppError::io(format!("moved note disappeared: {to}")))?;
    if file_identity(&moved)? != source_identity {
        let _ = rename_noreplace(
            &destination_parent.directory,
            &destination_parent.file_name,
            &source_parent.directory,
            &source_parent.file_name,
        );
        return Err(AppError::io(format!(
            "cannot move note: {from} changed while the move committed"
        )));
    }
    if placeholder_exists(&destination_parent.directory, &destination_parent.file_name)? {
        rename_noreplace(
            &destination_parent.directory,
            &destination_parent.file_name,
            &source_parent.directory,
            &source_parent.file_name,
        )
        .map_err(|error| safe_mutation_error(from, error))?;
        return Err(AppError::io(format!(
            "cannot move note: {to} is occupied by an iCloud placeholder"
        )));
    }
    Ok(())
}

/// A note moved into the graph-local recovery directory. Desktop callers
/// revalidate its ambient pathname before handing it to the OS Trash API;
/// mobile callers leave it here as their recoverable trash item.
pub(super) struct PinnedTrashEntry {
    trash_directory: Dir,
    trash_components: Vec<String>,
    trash_name: String,
    file: File,
    original_parent: PinnedParent,
    original_name: String,
}

impl PinnedTrashEntry {
    /// Revalidate the pinned root, trash directory, and file identity before
    /// crossing the descriptor-to-path boundary required by the OS Trash API.
    pub(super) fn revalidated_ambient_path(&self, root: &PinnedGraphRoot) -> AppResult<PathBuf> {
        super::ensure_pinned_root_path_identity(root)?;
        revalidate_directory(root, &self.trash_components, &self.trash_directory)?;
        let current = open_regular_file(&self.trash_directory, &self.trash_name, &self.trash_name)?
            .ok_or_else(|| AppError::not_found("staged trash item disappeared"))?;
        if file_identity(&current)? != file_identity(&self.file)? {
            return Err(AppError::traversal(
                "staged trash item changed before the OS Trash handoff",
            ));
        }
        Ok(root
            .path
            .join(REFLECT_DIR)
            .join("trash")
            .join(&self.trash_name))
    }

    /// Restore a staged delete after an OS Trash failure. This is itself a
    /// no-clobber rename; if something reclaimed the original path, the staged
    /// recovery copy remains under `.reflect/trash/`.
    pub(super) fn rollback(self) -> AppResult<()> {
        if visible_path_occupied(
            &self.original_parent.directory,
            &self.original_parent.file_name,
        )? {
            return Err(AppError::io(
                "could not restore note after Trash failure because its path is occupied",
            ));
        }
        rename_noreplace(
            &self.trash_directory,
            &self.trash_name,
            &self.original_parent.directory,
            &self.original_name,
        )
        .map_err(|error| safe_mutation_error(&self.original_name, error))
    }
}

pub(super) fn stage_delete_pinned(
    root: &PinnedGraphRoot,
    path: &str,
) -> AppResult<PinnedTrashEntry> {
    stage_delete_pinned_with(root, path, || {})
}

fn stage_delete_pinned_with<F>(
    root: &PinnedGraphRoot,
    path: &str,
    before_commit: F,
) -> AppResult<PinnedTrashEntry>
where
    F: FnOnce(),
{
    super::ensure_pinned_root_path_identity(root)?;
    let mut original_parent = open_visible_parent(root, path, false)?;
    let (source_name, source) =
        match open_regular_file(&original_parent.directory, &original_parent.file_name, path)? {
            Some(file) => (original_parent.file_name.clone(), file),
            None => {
                let placeholder_name = placeholder_name(&original_parent.file_name);
                let placeholder =
                    open_regular_file(&original_parent.directory, &placeholder_name, path)?
                        .ok_or_else(|| AppError::not_found(format!("note not found: {path}")))?;
                (placeholder_name, placeholder)
            }
        };
    let source_identity = file_identity(&source)?;
    let (trash_directory, trash_components) =
        open_internal_directory(root, &[REFLECT_DIR, "trash"], true)?;
    let trash_name = available_trash_name(&trash_directory, &source_name)?;

    let _commit_guard = lock_mutation_commit()?;
    before_commit();
    revalidate_visible_parent(root, &original_parent)?;
    revalidate_directory(root, &trash_components, &trash_directory)?;
    let current_source = open_regular_file(&original_parent.directory, &source_name, path)?
        .ok_or_else(|| AppError::not_found(format!("note not found: {path}")))?;
    if file_identity(&current_source)? != source_identity {
        return Err(AppError::io(format!(
            "cannot delete note: {path} changed before the delete committed"
        )));
    }
    rename_noreplace(
        &original_parent.directory,
        &source_name,
        &trash_directory,
        &trash_name,
    )
    .map_err(|error| safe_mutation_error(path, error))?;

    let staged = open_regular_file(&trash_directory, &trash_name, path)?
        .ok_or_else(|| AppError::io("staged trash item disappeared"))?;
    if file_identity(&staged)? != source_identity {
        let _ = rename_noreplace(
            &trash_directory,
            &trash_name,
            &original_parent.directory,
            &source_name,
        );
        return Err(AppError::io(format!(
            "cannot delete note: {path} changed while the delete committed"
        )));
    }
    original_parent.file_name = source_name.clone();
    Ok(PinnedTrashEntry {
        trash_directory,
        trash_components,
        trash_name,
        file: staged,
        original_parent,
        original_name: source_name,
    })
}

/// Best-effort capability-relative maintenance for the local sync ancestor
/// cache after a successful note move.
pub(super) fn move_shadow_entries_pinned(root: &PinnedGraphRoot, from: &str, to: &str) {
    for suffix in ["", ".pair"] {
        let from_path = format!("{from}{suffix}");
        let to_path = format!("{to}{suffix}");
        let Ok(Some(source_parent)) = open_shadow_parent(root, &from_path, false) else {
            continue;
        };
        let Ok(Some(destination_parent)) = open_shadow_parent(root, &to_path, true) else {
            continue;
        };
        if entry_exists(&source_parent.directory, &source_parent.file_name).unwrap_or(false) {
            let _ = source_parent.directory.rename(
                &source_parent.file_name,
                &destination_parent.directory,
                &destination_parent.file_name,
            );
        }
    }
}

/// Best-effort capability-relative maintenance for the local sync ancestor
/// cache after a successful note delete.
pub(super) fn forget_shadow_entries_pinned(root: &PinnedGraphRoot, path: &str) {
    for suffix in ["", ".pair"] {
        let shadow_path = format!("{path}{suffix}");
        let Ok(Some(parent)) = open_shadow_parent(root, &shadow_path, false) else {
            continue;
        };
        let _ = parent.directory.remove_file(&parent.file_name);
    }
}

struct PinnedParent {
    directory: Dir,
    parent_components: Vec<String>,
    file_name: String,
}

struct StagedFile {
    directory: Dir,
    file_name: String,
    file: File,
    published: bool,
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = self.directory.remove_file(&self.file_name);
        }
    }
}

fn reclaim_published_stage(
    staged: &mut StagedFile,
    parent: &PinnedParent,
    path: &str,
) -> AppResult<()> {
    let current = open_regular_file(&parent.directory, &parent.file_name, path)?
        .ok_or_else(|| AppError::io(format!("published file disappeared: {path}")))?;
    if file_identity(&current)? != file_identity(&staged.file)? {
        return Err(AppError::traversal(format!(
            "published file changed before collision rollback: {path}"
        )));
    }
    rename_noreplace(
        &parent.directory,
        &parent.file_name,
        &staged.directory,
        &staged.file_name,
    )
    .map_err(|error| safe_mutation_error(path, error))?;
    staged.published = false;
    Ok(())
}

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn stage_pinned_bytes(root: &PinnedGraphRoot, contents: &[u8]) -> AppResult<StagedFile> {
    let (directory, _) = open_internal_directory(root, &[REFLECT_DIR, "tmp"], true)?;
    for _ in 0..128 {
        let serial = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let file_name = format!("write-{}-{serial}.tmp", std::process::id());
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        match directory.open_with(&file_name, &options) {
            Ok(mut file) => {
                file.write_all(contents)?;
                file.sync_all()?;
                return Ok(StagedFile {
                    directory,
                    file_name,
                    file,
                    published: false,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(safe_mutation_error(".reflect/tmp", error)),
        }
    }
    Err(AppError::io(
        "could not allocate a unique atomic-write staging file",
    ))
}

fn visible_components(path: &str) -> AppResult<Vec<String>> {
    let bytes = path.as_bytes();
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(AppError::traversal(format!(
            "mutation path is not graph-relative: {path}"
        )));
    }
    let components: Vec<String> = path.split('/').map(str::to_string).collect();
    if components
        .iter()
        .any(|component| component.is_empty() || component.starts_with('.'))
    {
        return Err(AppError::traversal(format!(
            "mutation path contains a hidden or invalid component: {path}"
        )));
    }
    Ok(components)
}

fn open_visible_parent(
    root: &PinnedGraphRoot,
    path: &str,
    create: bool,
) -> AppResult<PinnedParent> {
    let components = visible_components(path)?;
    let (file_name, parent_components) = components
        .split_last()
        .ok_or_else(|| AppError::traversal("mutation path is empty"))?;
    let directory = open_directory_components(&root.capability, parent_components, create, path)?;
    Ok(PinnedParent {
        directory,
        parent_components: parent_components.to_vec(),
        file_name: file_name.clone(),
    })
}

fn open_shadow_parent(
    root: &PinnedGraphRoot,
    path: &str,
    create: bool,
) -> AppResult<Option<PinnedParent>> {
    let components = visible_components(path)?;
    let (file_name, note_parent_components) = components
        .split_last()
        .ok_or_else(|| AppError::traversal("shadow path is empty"))?;
    let mut parent_components = vec![REFLECT_DIR.to_string(), "sync-base".to_string()];
    parent_components.extend_from_slice(note_parent_components);
    match open_directory_components(&root.capability, &parent_components, create, path) {
        Ok(directory) => Ok(Some(PinnedParent {
            directory,
            parent_components,
            file_name: file_name.clone(),
        })),
        Err(AppError::NotFound { .. }) if !create => Ok(None),
        Err(error) => Err(error),
    }
}

fn open_internal_directory(
    root: &PinnedGraphRoot,
    components: &[&str],
    create: bool,
) -> AppResult<(Dir, Vec<String>)> {
    let components: Vec<String> = components
        .iter()
        .map(|component| (*component).to_string())
        .collect();
    let directory = open_directory_components(&root.capability, &components, create, ".reflect")?;
    Ok((directory, components))
}

fn open_directory_components(
    root: &Dir,
    components: &[String],
    create: bool,
    display_path: &str,
) -> AppResult<Dir> {
    let mut current = root.try_clone()?;
    for component in components {
        current = if create {
            open_or_create_dir_nofollow(&current, component, display_path)?
        } else {
            current
                .open_dir_nofollow(component)
                .map_err(|error| safe_mutation_error(display_path, error))?
        };
    }
    Ok(current)
}

fn open_or_create_dir_nofollow(
    parent: &Dir,
    component: &str,
    display_path: &str,
) -> AppResult<Dir> {
    match parent.open_dir_nofollow(component) {
        Ok(directory) => Ok(directory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match parent.create_dir(component) {
                Ok(()) => {}
                Err(create_error) if create_error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(create_error) => {
                    return Err(safe_mutation_error(display_path, create_error));
                }
            }
            parent
                .open_dir_nofollow(component)
                .map_err(|open_error| safe_mutation_error(display_path, open_error))
        }
        Err(error) => Err(safe_mutation_error(display_path, error)),
    }
}

fn revalidate_visible_parent(root: &PinnedGraphRoot, parent: &PinnedParent) -> AppResult<()> {
    super::ensure_pinned_root_path_identity(root)?;
    revalidate_directory(root, &parent.parent_components, &parent.directory)
}

fn revalidate_directory(
    root: &PinnedGraphRoot,
    components: &[String],
    original: &Dir,
) -> AppResult<()> {
    let current = open_directory_components(&root.capability, components, false, "mutation path")?;
    if directory_identity(&current)? != directory_identity(original)? {
        return Err(AppError::traversal(
            "a mutation path directory changed before the operation committed",
        ));
    }
    Ok(())
}

fn ensure_replaceable_target(directory: &Dir, file_name: &str, path: &str) -> AppResult<()> {
    match directory.symlink_metadata(file_name) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(AppError::traversal(format!(
            "mutation target is not a regular file: {path}"
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if placeholder_exists(directory, file_name)? {
                Err(AppError::not_found(format!(
                    "mutation target is unavailable on this device: {path}"
                )))
            } else {
                Ok(())
            }
        }
        Err(error) => Err(safe_mutation_error(path, error)),
    }
}

fn open_regular_file(directory: &Dir, file_name: &str, path: &str) -> AppResult<Option<File>> {
    match directory.symlink_metadata(file_name) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(AppError::traversal(format!(
                "mutation path is not a regular file: {path}"
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(safe_mutation_error(path, error)),
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    match directory.open_with(file_name, &options) {
        Ok(file) if file.metadata()?.is_file() => Ok(Some(file)),
        Ok(_) => Err(AppError::traversal(format!(
            "mutation path is not a regular file: {path}"
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(safe_mutation_error(path, error)),
    }
}

fn visible_path_occupied(directory: &Dir, file_name: &str) -> AppResult<bool> {
    Ok(entry_exists(directory, file_name)? || placeholder_exists(directory, file_name)?)
}

fn placeholder_exists(directory: &Dir, file_name: &str) -> AppResult<bool> {
    entry_exists(directory, &placeholder_name(file_name))
}

fn placeholder_name(file_name: &str) -> String {
    format!(".{file_name}.icloud")
}

fn entry_exists(directory: &Dir, file_name: &str) -> AppResult<bool> {
    match directory.symlink_metadata(file_name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(safe_mutation_error(file_name, error)),
    }
}

fn available_trash_name(directory: &Dir, source_name: &str) -> AppResult<String> {
    if !entry_exists(directory, source_name)? {
        return Ok(source_name.to_string());
    }
    for _ in 0..128 {
        let serial = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("deleted-{}-{serial}-{source_name}", std::process::id());
        if !entry_exists(directory, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(AppError::io(
        "could not allocate a unique graph-trash filename",
    ))
}

fn directory_identity(directory: &Dir) -> AppResult<Handle> {
    Ok(Handle::from_file(directory.try_clone()?.into_std_file())?)
}

fn file_identity(file: &File) -> AppResult<Handle> {
    Ok(Handle::from_file(file.try_clone()?.into_std())?)
}

fn cap_modified_ms(metadata: &cap_std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn safe_mutation_error(path: &str, error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::NotFound {
        return AppError::not_found(format!("mutation path not found: {path}"));
    }
    if matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::AlreadyExists
            | std::io::ErrorKind::StorageFull
            | std::io::ErrorKind::ReadOnlyFilesystem
    ) {
        return AppError::io(error.to_string());
    }
    AppError::traversal(format!(
        "mutation path could not be used without following symlinks: {path}: {error}"
    ))
}

/// Descriptor-relative no-clobber rename. Apple/Linux/Android use the native
/// exclusive rename operation, retaining one atomic namespace transition.
/// Other platforms use the same hard-link + unlink fallback as `tempfile`'s
/// `persist_noclobber`. Failed-source-unlink cleanup is identity guarded so a
/// replacement destination is never knowingly removed.
pub(super) fn rename_noreplace(
    from_directory: &Dir,
    from: &str,
    to_directory: &Dir,
    to: &str,
) -> std::io::Result<()> {
    #[cfg(any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos"
    ))]
    {
        use rustix::fs::{renameat_with, RenameFlags};
        use rustix::io::Errno;

        match renameat_with(
            from_directory,
            from,
            to_directory,
            to,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => return Ok(()),
            Err(Errno::NOSYS | Errno::INVAL) => {}
            Err(error) => return Err(error.into()),
        }
    }

    rename_noreplace_fallback_with(
        from_directory,
        from,
        to_directory,
        to,
        |_, _| {},
        |directory, path| directory.remove_file(path),
    )
}

/// Descriptor-relative no-clobber rename for directories. Windows rename is
/// natively no-replace; Apple/Linux/Android use `renameat2`/`renamex_np` via
/// rustix. The final fallback is used only on unsupported targets.
pub(super) fn rename_directory_noreplace(
    from_directory: &Dir,
    from: &Path,
    to_directory: &Dir,
    to: &Path,
) -> std::io::Result<()> {
    #[cfg(any(
        target_os = "android",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos"
    ))]
    {
        use rustix::fs::{renameat_with, RenameFlags};
        use rustix::io::Errno;

        match renameat_with(
            from_directory,
            from,
            to_directory,
            to,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => return Ok(()),
            Err(Errno::NOSYS | Errno::INVAL) => {}
            Err(error) => return Err(error.into()),
        }
    }

    #[cfg(target_os = "windows")]
    {
        return from_directory.rename(from, to_directory, to);
    }

    #[cfg(not(target_os = "windows"))]
    {
        match to_directory.symlink_metadata(to) {
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "directory rename destination already exists",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        from_directory.rename(from, to_directory, to)
    }
}

fn rename_noreplace_fallback_with<AfterLink, RemoveSource>(
    from_directory: &Dir,
    from: &str,
    to_directory: &Dir,
    to: &str,
    after_link: AfterLink,
    remove_source: RemoveSource,
) -> std::io::Result<()>
where
    AfterLink: FnOnce(&Dir, &str),
    RemoveSource: FnOnce(&Dir, &str) -> std::io::Result<()>,
{
    let source_identity = nofollow_regular_file_identity(from_directory, from)?
        .ok_or_else(|| std::io::Error::other("hard-link source is not a regular file"))?;
    from_directory.hard_link(from, to_directory, to)?;
    after_link(to_directory, to);
    if nofollow_regular_file_identity(to_directory, to)?.as_ref() != Some(&source_identity) {
        return Err(std::io::Error::other(
            "hard-link destination changed before source cleanup",
        ));
    }
    if let Err(error) = remove_source(from_directory, from) {
        if nofollow_regular_file_identity(to_directory, to)?.as_ref() == Some(&source_identity) {
            let _ = to_directory.remove_file(to);
        }
        return Err(error);
    }
    Ok(())
}

fn nofollow_regular_file_identity(
    directory: &Dir,
    file_name: &str,
) -> std::io::Result<Option<Handle>> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    match directory.open_with(file_name, &options) {
        Ok(file) if file.metadata()?.is_file() => Handle::from_file(file.into_std()).map(Some),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
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

/// Whether a path is **occupied**: a readable file, or an evicted iCloud note
/// whose placeholder still holds the name. Existence probes that guard
/// against overwriting (the collision picker's `note_exists`, the rename
/// destination check) must use this — an evicted note looks vacant to
/// `is_file()` but comes back the moment iCloud re-downloads it, and anything
/// created in its place becomes a conflict.
pub(crate) fn file_occupied(abs: &Path) -> bool {
    abs.is_file() || eviction_placeholder(abs).is_some_and(|stub| stub.exists())
}

/// Recursively list every eligible Markdown note from the graph root.
///
/// Hidden directories and the reserved attachment trees are pruned before
/// descent. Symlinks are never followed. An iCloud placeholder is classified
/// by the visible logical path it represents, so its dot-prefixed stub name is
/// not mistaken for a user-hidden note.
pub(super) fn collect_note_files(root: &Path) -> AppResult<Vec<FileMeta>> {
    Ok(collect_classified_files(root, false)?.notes)
}

/// Build one snapshot of every eligible note and supported attachment.
pub(super) fn collect_file_catalog(root: &Path) -> AppResult<FileCatalog> {
    collect_classified_files(root, true)
}

fn collect_classified_files(root: &Path, include_attachments: bool) -> AppResult<FileCatalog> {
    let mut catalog = FileCatalog::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            if file_type.is_dir() {
                let descend = if include_attachments {
                    reflect_graph_paths::is_safe_visible_relative(rel)
                } else {
                    reflect_graph_paths::may_contain_notes(rel)
                };
                if descend {
                    stack.push(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let listed = match evicted_logical_path(&path) {
                Some(logical) if !logical.exists() => logical
                    .strip_prefix(root)
                    .ok()
                    .and_then(reflect_graph_paths::classify)
                    .map(|kind| (logical, true, kind)),
                Some(_) => None,
                None => reflect_graph_paths::classify(rel).map(|kind| (path, false, kind)),
            };
            let Some((listed_path, placeholder, kind)) = listed else {
                continue;
            };
            if kind == reflect_graph_paths::GraphPathKind::Attachment && !include_attachments {
                continue;
            }
            let Ok(listed_rel) = listed_path.strip_prefix(root) else {
                continue;
            };
            let meta = entry.metadata()?;
            let file = FileMeta {
                path: listed_rel.to_string_lossy().replace('\\', "/"),
                size: meta.len(),
                modified_ms: modified_ms(&meta).unwrap_or(0),
                placeholder,
            };
            match kind {
                reflect_graph_paths::GraphPathKind::Note => catalog.notes.push(file),
                reflect_graph_paths::GraphPathKind::Attachment => catalog.attachments.push(file),
            }
        }
    }
    catalog
        .notes
        .sort_by(|left, right| left.path.cmp(&right.path));
    catalog
        .attachments
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn pinned(root: &Path) -> PinnedGraphRoot {
        PinnedGraphRoot {
            path: root.to_path_buf(),
            capability: Arc::new(
                Dir::open_ambient_dir(root, ambient_authority()).expect("root capability"),
            ),
        }
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
        git2::Repository::init(dir.path()).unwrap();
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
    fn pinned_atomic_write_round_trips_and_stages_under_reflect_tmp() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let root = pinned(dir.path());

        atomic_write_pinned(&root, "Projects/deep/plan.md", "# Plan\n").unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("Projects/deep/plan.md")).unwrap(),
            "# Plan\n"
        );
        assert!(dir.path().join(".reflect/tmp").is_dir());
        assert_eq!(
            fs::read_dir(dir.path().join(".reflect/tmp"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn pinned_write_rejects_a_root_renamed_and_replaced_before_commit() {
        let parent = tempdir().unwrap();
        let root_path = parent.path().join("vault");
        let moved_path = parent.path().join("moved-vault");
        fs::create_dir(&root_path).unwrap();
        bootstrap(&root_path).unwrap();
        fs::create_dir(root_path.join("Projects")).unwrap();
        fs::write(root_path.join("Projects/plan.md"), "original\n").unwrap();
        let root = pinned(&root_path);

        let result =
            atomic_write_bytes_pinned_with(&root, "Projects/plan.md", b"mutated\n", || {
                fs::rename(&root_path, &moved_path).unwrap();
                fs::create_dir(&root_path).unwrap();
                fs::create_dir(root_path.join("Projects")).unwrap();
                fs::write(root_path.join("Projects/plan.md"), "replacement\n").unwrap();
            });

        assert!(matches!(result, Err(AppError::Traversal { .. })));
        assert_eq!(
            fs::read_to_string(moved_path.join("Projects/plan.md")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(root_path.join("Projects/plan.md")).unwrap(),
            "replacement\n"
        );
        assert_eq!(
            fs::read_dir(moved_path.join(".reflect/tmp"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn pinned_write_rejects_a_descendant_symlink_swap_before_commit() {
        use std::os::unix::fs::symlink;

        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        bootstrap(vault.path()).unwrap();
        fs::create_dir(vault.path().join("Projects")).unwrap();
        fs::write(vault.path().join("Projects/plan.md"), "original\n").unwrap();
        fs::write(outside.path().join("plan.md"), "outside\n").unwrap();
        let root = pinned(vault.path());

        let result =
            atomic_write_bytes_pinned_with(&root, "Projects/plan.md", b"mutated\n", || {
                fs::rename(
                    vault.path().join("Projects"),
                    vault.path().join("Projects-detached"),
                )
                .unwrap();
                symlink(outside.path(), vault.path().join("Projects")).unwrap();
            });

        assert!(matches!(result, Err(AppError::Traversal { .. })));
        assert_eq!(
            fs::read_to_string(vault.path().join("Projects-detached/plan.md")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("plan.md")).unwrap(),
            "outside\n"
        );
    }

    #[test]
    fn pinned_conditional_write_rechecks_bytes_at_commit() {
        let vault = tempdir().unwrap();
        bootstrap(vault.path()).unwrap();
        fs::write(vault.path().join("notes/source.md"), "before\n").unwrap();
        let root = pinned(vault.path());

        let result = atomic_write_if_unchanged_pinned_with(
            &root,
            "notes/source.md",
            Some("before\n"),
            "ours\n",
            || fs::write(vault.path().join("notes/source.md"), "external\n").unwrap(),
        )
        .unwrap();

        assert_eq!(result, AtomicConditionalWriteOutcome::Changed);
        assert_eq!(
            fs::read_to_string(vault.path().join("notes/source.md")).unwrap(),
            "external\n"
        );
    }

    #[test]
    fn pinned_create_treats_a_placeholder_arriving_at_commit_as_a_collision() {
        let vault = tempdir().unwrap();
        bootstrap(vault.path()).unwrap();
        let root = pinned(vault.path());

        let result = atomic_create_pinned_with(&root, "notes/fresh.md", "ours\n", || {
            fs::write(vault.path().join("notes/.fresh.md.icloud"), "stub").unwrap()
        })
        .unwrap();

        assert_eq!(result, AtomicCreateOutcome::Collision);
        assert!(!vault.path().join("notes/fresh.md").exists());
        assert_eq!(
            fs::read_to_string(vault.path().join("notes/.fresh.md.icloud")).unwrap(),
            "stub"
        );
        assert_eq!(
            fs::read_dir(vault.path().join(".reflect/tmp"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn pinned_delete_rejects_a_descendant_symlink_swap_before_commit() {
        use std::os::unix::fs::symlink;

        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        bootstrap(vault.path()).unwrap();
        fs::write(vault.path().join("notes/a.md"), "original\n").unwrap();
        fs::write(outside.path().join("a.md"), "outside\n").unwrap();
        let root = pinned(vault.path());

        let result = stage_delete_pinned_with(&root, "notes/a.md", || {
            fs::rename(
                vault.path().join("notes"),
                vault.path().join("notes-detached"),
            )
            .unwrap();
            symlink(outside.path(), vault.path().join("notes")).unwrap();
        });

        assert!(matches!(result, Err(AppError::Traversal { .. })));
        assert_eq!(
            fs::read_to_string(vault.path().join("notes-detached/a.md")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("a.md")).unwrap(),
            "outside\n"
        );
        assert_eq!(
            fs::read_dir(vault.path().join(".reflect/trash"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn pinned_move_rejects_a_destination_symlink_swap_before_commit() {
        use std::os::unix::fs::symlink;

        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        bootstrap(vault.path()).unwrap();
        fs::write(vault.path().join("notes/a.md"), "original\n").unwrap();
        fs::create_dir(vault.path().join("Archive")).unwrap();
        fs::write(outside.path().join("b.md"), "outside\n").unwrap();
        let root = pinned(vault.path());

        let result = move_file_pinned_with(&root, "notes/a.md", "Archive/b.md", || {
            fs::rename(
                vault.path().join("Archive"),
                vault.path().join("Archive-detached"),
            )
            .unwrap();
            symlink(outside.path(), vault.path().join("Archive")).unwrap();
        });

        assert!(matches!(result, Err(AppError::Traversal { .. })));
        assert_eq!(
            fs::read_to_string(vault.path().join("notes/a.md")).unwrap(),
            "original\n"
        );
        assert!(!vault.path().join("Archive-detached/b.md").exists());
        assert_eq!(
            fs::read_to_string(outside.path().join("b.md")).unwrap(),
            "outside\n"
        );
    }

    #[test]
    fn pinned_delete_stages_and_rolls_back_an_icloud_placeholder() {
        let vault = tempdir().unwrap();
        bootstrap(vault.path()).unwrap();
        let placeholder = vault.path().join("notes/.evicted.md.icloud");
        fs::write(&placeholder, "stub\n").unwrap();
        let root = pinned(vault.path());

        let staged = stage_delete_pinned(&root, "notes/evicted.md").unwrap();
        assert!(!placeholder.exists());
        assert_eq!(
            fs::read_to_string(vault.path().join(".reflect/trash/.evicted.md.icloud")).unwrap(),
            "stub\n"
        );

        staged.rollback().unwrap();
        assert_eq!(fs::read_to_string(&placeholder).unwrap(), "stub\n");
        assert!(!vault
            .path()
            .join(".reflect/trash/.evicted.md.icloud")
            .exists());
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
    fn conditional_write_replaces_only_the_expected_bytes() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/source.md");
        atomic_write(dir.path(), &target, "before\n").unwrap();

        assert!(matches!(
            atomic_write_if_unchanged(dir.path(), &target, Some("before\n"), "after\n").unwrap(),
            AtomicConditionalWriteOutcome::Written(_)
        ));
        assert_eq!(fs::read_to_string(&target).unwrap(), "after\n");

        assert_eq!(
            atomic_write_if_unchanged(dir.path(), &target, Some("before\n"), "clobber\n").unwrap(),
            AtomicConditionalWriteOutcome::Changed
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "after\n");
    }

    #[test]
    fn conditional_write_treats_missing_as_changed_instead_of_recreating() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/removed.md");

        assert_eq!(
            atomic_write_if_unchanged(dir.path(), &target, Some("before\n"), "after\n").unwrap(),
            AtomicConditionalWriteOutcome::Changed
        );
        assert!(!target.exists());
    }

    #[test]
    fn conditional_absent_write_uses_the_no_clobber_create_path() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/fresh.md");

        assert!(matches!(
            atomic_write_if_unchanged(dir.path(), &target, None, "first\n").unwrap(),
            AtomicConditionalWriteOutcome::Written(_)
        ));
        assert_eq!(
            atomic_write_if_unchanged(dir.path(), &target, None, "replacement\n").unwrap(),
            AtomicConditionalWriteOutcome::Changed
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "first\n");
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
    fn hard_link_fallback_never_cleans_up_a_replacement_destination() {
        let vault = tempdir().unwrap();
        let source = vault.path().join("source.md");
        let destination = vault.path().join("destination.md");
        fs::write(&source, "source\n").unwrap();
        let directory = Dir::open_ambient_dir(vault.path(), ambient_authority()).unwrap();

        let error = rename_noreplace_fallback_with(
            &directory,
            "source.md",
            &directory,
            "destination.md",
            |_, _| {},
            |_, _| {
                fs::remove_file(&destination).unwrap();
                fs::write(&destination, "replacement\n").unwrap();
                Err(std::io::Error::other("simulated source unlink failure"))
            },
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(fs::read_to_string(source).unwrap(), "source\n");
        assert_eq!(fs::read_to_string(destination).unwrap(), "replacement\n");
    }

    #[test]
    fn hard_link_fallback_rejects_replacement_before_identity_validation() {
        let vault = tempdir().unwrap();
        let source = vault.path().join("source.md");
        let destination = vault.path().join("destination.md");
        fs::write(&source, "source\n").unwrap();
        let directory = Dir::open_ambient_dir(vault.path(), ambient_authority()).unwrap();
        let remove_source_called = std::cell::Cell::new(false);

        let error = rename_noreplace_fallback_with(
            &directory,
            "source.md",
            &directory,
            "destination.md",
            |_, _| {
                fs::remove_file(&destination).unwrap();
                fs::write(&destination, "replacement\n").unwrap();
            },
            |_, _| {
                remove_source_called.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert!(!remove_source_called.get());
        assert_eq!(fs::read_to_string(source).unwrap(), "source\n");
        assert_eq!(fs::read_to_string(destination).unwrap(), "replacement\n");
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
        atomic_write(
            dir.path(),
            &dir.path().join("Projects/deep/plan.md"),
            "nested",
        )
        .unwrap();
        atomic_write(dir.path(), &dir.path().join("assets/caption.md"), "asset").unwrap();
        atomic_write(
            dir.path(),
            &dir.path().join("audio-memos/transcript.md"),
            "audio",
        )
        .unwrap();
        atomic_write(
            dir.path(),
            &dir.path().join(".obsidian/plugin.md"),
            "hidden",
        )
        .unwrap();
        atomic_write(
            dir.path(),
            &dir.path().join("Projects/.private/secret.md"),
            "hidden",
        )
        .unwrap();
        atomic_write(dir.path(), &dir.path().join("Projects/upper.MD"), "upper").unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/skip.txt"), "c").unwrap();

        let out = collect_note_files(dir.path()).unwrap();
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"Projects/deep/plan.md"));
        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"daily/2026-06-09.md"));
        assert!(paths.contains(&"templates/journal.md"));
        assert!(!paths.iter().any(|p| p.ends_with(".txt")));
        assert!(!paths.iter().any(|p| p.starts_with("assets/")));
        assert!(!paths.iter().any(|p| p.starts_with("audio-memos/")));
        assert!(!paths.iter().any(|p| p.contains("/.")));
        assert!(!paths.iter().any(|p| p.ends_with(".MD")));
    }

    #[cfg(unix)]
    #[test]
    fn note_walk_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("outside.md"), "outside").unwrap();
        fs::create_dir_all(root.path().join("Projects")).unwrap();
        symlink(
            outside.path().join("outside.md"),
            root.path().join("linked.md"),
        )
        .unwrap();
        symlink(outside.path(), root.path().join("Projects/linked")).unwrap();

        assert!(collect_note_files(root.path()).unwrap().is_empty());
    }

    #[test]
    fn catalog_includes_supported_visible_attachments() {
        let root = tempdir().unwrap();
        for path in [
            "assets/photo.png",
            "Projects/reference.PDF",
            "Media/clip.mp4",
            "Media/ignore.zip",
            ".hidden/photo.png",
            "Media/.private/photo.png",
        ] {
            let absolute = root.path().join(path);
            fs::create_dir_all(absolute.parent().unwrap()).unwrap();
            fs::write(absolute, "bytes").unwrap();
        }

        let catalog = collect_file_catalog(root.path()).unwrap();
        let paths: Vec<&str> = catalog
            .attachments
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec![
                "Media/clip.mp4",
                "Projects/reference.PDF",
                "assets/photo.png"
            ]
        );
    }

    #[test]
    fn evicted_placeholders_list_as_their_logical_note() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        fs::write(dir.path().join("notes/.a.md.icloud"), b"stub").unwrap();

        let out = collect_note_files(dir.path()).unwrap();
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

        let out = collect_note_files(dir.path()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "notes/a.md");
        assert!(!out[0].placeholder);
    }

    #[test]
    fn placeholder_names_parse_only_the_icloud_shape() {
        assert_eq!(icloud_placeholder_target(".a.md.icloud"), Some("a.md"));
        assert_eq!(icloud_placeholder_target(".noext.icloud"), Some("noext"));
        // Not placeholders: no leading dot, no suffix, or nothing in between.
        assert_eq!(icloud_placeholder_target("a.md.icloud"), None);
        assert_eq!(icloud_placeholder_target(".a.md"), None);
        assert_eq!(icloud_placeholder_target(".icloud"), None);
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
}
