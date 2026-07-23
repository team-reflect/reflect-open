//! Disk primitives: graph bootstrap, atomic writes, and markdown listing.
//!
//! Pure IO — no Tauri state, no path policy (that's [`super::resolve`]). Writes
//! are atomic (temp file + rename) so a crash mid-write can never truncate a
//! note. Temp files are staged under `.reflect/tmp/` — the same volume, so the
//! rename stays atomic, but excluded from cloud sync so a crash-stranded temp
//! can never replicate to another device (Plan 21).

use std::fs;
use std::io::Write;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use std::os::raw::c_int;
use std::path::Path;
use std::time::UNIX_EPOCH;

use reflect_graph_paths::{evicted_logical_path, eviction_placeholder, is_dataless};

use crate::error::{AppError, AppResult};
use crate::graph_gitignore;

use super::FileMeta;

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
    sweep_upload_staging(root);
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
    let tmp = stage_bytes(root, target, contents)?;
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
