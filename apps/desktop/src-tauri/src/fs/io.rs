//! Disk primitives: graph bootstrap, atomic writes, and markdown listing.
//!
//! Pure IO — no Tauri state, no path policy (that's [`super::resolve`]). Writes
//! are atomic (temp file + rename) so a crash mid-write can never truncate a
//! note. Temp files are staged under `.reflect/tmp/` — the same volume, so the
//! rename stays atomic, but excluded from cloud sync so a crash-stranded temp
//! can never replicate to another device (Plan 21).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::graph_gitignore;

use super::FileMeta;

pub(super) const REFLECT_DIR: &str = ".reflect";
const META_SCHEMA_VERSION: u32 = 1;
pub(super) const TOP_LEVEL_DIRS: [&str; 4] = ["daily", "notes", "assets", REFLECT_DIR];
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
/// Directories scanned by `list_files` for markdown notes. `templates/` is
/// not bootstrapped (no-litter) — the first template write creates it.
pub(super) const NOTE_DIRS: [&str; 3] = ["daily", "notes", "templates"];

/// Create the standard graph layout + ignore/meta files (idempotent).
pub(super) fn bootstrap(root: &Path) -> AppResult<()> {
    for dir in TOP_LEVEL_DIRS {
        fs::create_dir_all(root.join(dir))?;
    }
    sweep_upload_staging(root);
    mark_dir_local_only(&root.join(REFLECT_DIR));
    // A backup repo must never ride a file-sync provider: two devices' object
    // stores merging file-by-file is repository corruption (Plan 21). New
    // repos are marked at init (`git::repo`); this covers pre-existing ones.
    let git_dir = root.join(".git");
    if git_dir.exists() {
        mark_dir_local_only(&git_dir);
    }
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, graph_gitignore::default_contents())?;
    }
    let meta = root.join(REFLECT_DIR).join("meta.json");
    if !meta.exists() {
        fs::write(
            &meta,
            format!("{{\n  \"schemaVersion\": {META_SCHEMA_VERSION}\n}}\n"),
        )?;
    }
    Ok(())
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

/// The logical file name behind an iCloud eviction placeholder:
/// `".<name>.icloud"` → `Some("<name>")`, anything else → `None`. Optimize
/// Storage replaces a not-downloaded file with such a stub; to the rest of the
/// app the file still exists — it just isn't readable until re-downloaded
/// (Plan 21: eviction must never read as deletion).
pub(crate) fn icloud_placeholder_target(file_name: &str) -> Option<&str> {
    let name = file_name.strip_prefix('.')?.strip_suffix(".icloud")?;
    (!name.is_empty()).then_some(name)
}

/// The placeholder path iCloud leaves behind when it evicts `logical`
/// (`notes/a.md` → `notes/.a.md.icloud`).
pub(crate) fn eviction_placeholder(logical: &Path) -> Option<PathBuf> {
    let name = logical.file_name()?.to_str()?;
    Some(logical.with_file_name(format!(".{name}.icloud")))
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
                placeholder,
            });
        }
    }
    Ok(())
}

/// If `path` is an eviction placeholder, the sibling path of the file it
/// stands in for (`notes/.a.md.icloud` → `notes/a.md`).
fn evicted_logical_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let logical = icloud_placeholder_target(name)?;
    Some(path.with_file_name(logical))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
    fn list_finds_only_markdown_under_note_dirs() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/a.md"), "a").unwrap();
        atomic_write(dir.path(), &dir.path().join("daily/2026-06-09.md"), "b").unwrap();
        atomic_write(dir.path(), &dir.path().join("templates/journal.md"), "t").unwrap();
        atomic_write(dir.path(), &dir.path().join("notes/skip.txt"), "c").unwrap();

        let mut out = Vec::new();
        for d in NOTE_DIRS {
            collect_files(dir.path(), d, Some("md"), &mut out).unwrap();
        }
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"daily/2026-06-09.md"));
        assert!(paths.contains(&"templates/journal.md"));
        assert!(!paths.iter().any(|p| p.ends_with(".txt")));
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
