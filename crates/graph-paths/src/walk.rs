//! The one vault walk, shared by the desktop shell and the CLI.
//!
//! Built on the `ignore` crate (ripgrep's walker): per-entry errors instead of
//! aborting the listing, no symlink following, and `.gitignore`-aware pruning
//! so an adopted vault that is also a code checkout does not flood the index
//! with dependency trees. Classification is [`crate::classify`]; hidden-entry
//! policy lives here because the walker must keep exactly one class of
//! dot-name visible: iCloud eviction placeholders, which list as the logical
//! file they stand in for.

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;

use crate::{
    classify, evicted_logical_path, icloud_placeholder_target, is_dataless, wire_path,
    GraphPathKind,
};

/// Per-directory ignore file for user-configured exclusions, same syntax and
/// precedence as `.gitignore`.
pub const REFLECT_IGNORE_FILE: &str = ".reflectignore";

/// Machine-generated trees that are never notes, pruned at any depth. Kept
/// deliberately narrow: every name here must answer "nobody uses this as a
/// notes folder". Ambiguous names (`target`, `build`, `vendor`) are covered
/// by the `CACHEDIR.TAG` probe instead of being guessed at.
const PRUNED_DIR_NAMES: [&str; 5] = [
    "node_modules",
    "bower_components",
    "__pycache__",
    "Pods",
    "DerivedData",
];

/// Signature of the Cache Directory Tagging Specification. Cargo stamps
/// `target/` with it; any tagged directory is a rebuildable cache, not notes.
const CACHEDIR_TAG_SIGNATURE: &[u8] = b"Signature: 8a477f597d28d172789f06886806bc55";

/// One eligible file from a vault walk, in canonical wire-path form.
#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
    /// The file is currently an iCloud eviction placeholder: present in the
    /// vault but unreadable until re-downloaded (eviction is never deletion).
    pub placeholder: bool,
}

/// One snapshot of every eligible note and supported attachment.
#[derive(Debug, Clone, Default)]
pub struct FileCatalog {
    pub notes: Vec<FileEntry>,
    pub attachments: Vec<FileEntry>,
    /// Entries the walk refused or failed to list: unreadable directories,
    /// unreadable metadata, symlinks, and default-pruned trees. Surfaced so
    /// "why isn't my file showing up" is always diagnosable.
    pub skipped: u32,
}

/// Recursively list every eligible note and supported attachment under `root`.
///
/// Hidden entries are pruned except iCloud eviction placeholders, which list
/// as their logical file. Symlinks are never followed and never listed. The
/// vault's own `.gitignore` files (no repository required, no global or
/// parent-directory rules) and [`REFLECT_IGNORE_FILE`] files prune subtrees;
/// [`PRUNED_DIR_NAMES`] and `CACHEDIR.TAG`-tagged directories are always
/// pruned. Every refusal is counted, never fatal: one unreadable directory
/// costs that directory, not the listing.
pub fn walk_catalog(root: &Path) -> FileCatalog {
    let skipped = Arc::new(AtomicU32::new(0));
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(false)
        .parents(false)
        .git_global(false)
        .require_git(false)
        .follow_links(false)
        .add_custom_ignore_filename(REFLECT_IGNORE_FILE);
    let filter_skipped = Arc::clone(&skipped);
    builder.filter_entry(move |entry| {
        if entry.depth() == 0 {
            return true;
        }
        if entry.path_is_symlink() {
            filter_skipped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') {
            return entry.file_type().is_some_and(|kind| kind.is_file())
                && icloud_placeholder_target(&name).is_some();
        }
        if entry.file_type().is_some_and(|kind| kind.is_dir()) && is_pruned_dir(&name, entry.path())
        {
            filter_skipped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        true
    });

    let mut catalog = FileCatalog::default();
    for result in builder.build() {
        let Ok(entry) = result else {
            skipped.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        // A placeholder lists as the logical file it stands in for, unless
        // something already occupies that name (mid-download both exist).
        let listed = match evicted_logical_path(rel) {
            Some(logical_rel) => {
                let occupied = path
                    .with_file_name(logical_rel.file_name().unwrap_or_default())
                    .symlink_metadata()
                    .is_ok();
                if occupied {
                    None
                } else {
                    wire_path(&logical_rel).map(|wire| (wire, true))
                }
            }
            None => wire_path(rel).map(|wire| (wire, false)),
        };
        let Some((wire, placeholder)) = listed else {
            continue;
        };
        let Some(kind) = classify(&wire) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            skipped.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let file = FileEntry {
            path: wire,
            size: meta.len(),
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
            // Two eviction forms fold into one flag: the legacy `.icloud`
            // stub (detected by name above) and the modern dataless file
            // (kernel flag on the real path).
            placeholder: placeholder || is_dataless(&meta),
        };
        match kind {
            GraphPathKind::Note => catalog.notes.push(file),
            GraphPathKind::Attachment => catalog.attachments.push(file),
        }
    }
    catalog
        .notes
        .sort_by(|left, right| left.path.cmp(&right.path));
    catalog
        .attachments
        .sort_by(|left, right| left.path.cmp(&right.path));
    catalog.skipped = skipped.load(Ordering::Relaxed);
    catalog
}

fn is_pruned_dir(name: &str, path: &Path) -> bool {
    PRUNED_DIR_NAMES
        .iter()
        .any(|pruned| name.eq_ignore_ascii_case(pruned))
        || has_cachedir_tag(path)
}

fn has_cachedir_tag(dir: &Path) -> bool {
    let Ok(file) = std::fs::File::open(dir.join("CACHEDIR.TAG")) else {
        return false;
    };
    let mut prefix = [0u8; CACHEDIR_TAG_SIGNATURE.len()];
    let mut handle = file.take(CACHEDIR_TAG_SIGNATURE.len() as u64);
    let Ok(()) = handle.read_exact(&mut prefix) else {
        return false;
    };
    prefix == CACHEDIR_TAG_SIGNATURE
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::tempdir;

    use super::walk_catalog;

    fn write(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn note_paths(root: &Path) -> Vec<String> {
        walk_catalog(root)
            .notes
            .into_iter()
            .map(|file| file.path)
            .collect()
    }

    #[test]
    fn finds_markdown_anywhere_and_prunes_reserved_and_hidden_trees() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "README.md", "root");
        write(root, "notes/a.md", "a");
        write(root, "daily/2026-06-09.md", "b");
        write(root, "templates/journal.md", "t");
        write(root, "Projects/deep/plan.md", "nested");
        write(root, "assets/caption.md", "asset");
        write(root, "audio-memos/transcript.md", "audio");
        write(root, ".obsidian/plugin.md", "hidden");
        write(root, "Projects/.private/secret.md", "hidden");
        write(root, "Projects/upper.MD", "upper");
        write(root, "notes/skip.txt", "c");
        write(root, "assets/photo.png", "png");
        write(root, "Media/clip.MP4", "video");

        let catalog = walk_catalog(root);
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            notes,
            vec![
                "Projects/deep/plan.md",
                "README.md",
                "daily/2026-06-09.md",
                "notes/a.md",
                "templates/journal.md",
            ]
        );
        let attachments: Vec<&str> = catalog
            .attachments
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(attachments, vec!["Media/clip.MP4", "assets/photo.png"]);
        assert!(catalog
            .notes
            .iter()
            .all(|f| !f.placeholder && f.modified_ms > 0));
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_or_lists_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = dir.path();
        write(outside.path(), "linked/evil.md", "outside");
        write(root, "notes/real.md", "real");
        symlink(outside.path().join("linked"), root.join("linked")).unwrap();
        symlink(outside.path().join("linked/evil.md"), root.join("alias.md")).unwrap();

        let catalog = walk_catalog(root);
        assert_eq!(note_paths(root), vec!["notes/real.md"]);
        assert!(catalog.skipped >= 2, "symlinks must count as skipped");
    }

    #[test]
    fn placeholders_list_as_their_logical_file_until_it_materializes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "Projects/.plan.md.icloud", "stub");
        write(root, "notes/.here.md.icloud", "stub");
        write(root, "notes/here.md", "downloaded");

        let catalog = walk_catalog(root);
        let listed: Vec<(&str, bool)> = catalog
            .notes
            .iter()
            .map(|f| (f.path.as_str(), f.placeholder))
            .collect();
        assert_eq!(
            listed,
            vec![("Projects/plan.md", true), ("notes/here.md", false)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_directory_costs_itself_not_the_listing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "notes/a.md", "a");
        write(root, "locked/hidden.md", "unreachable");
        let locked = root.join("locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let catalog = walk_catalog(root);

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(notes, vec!["notes/a.md"]);
        assert!(
            catalog.skipped >= 1,
            "the unreadable directory must be counted"
        );
    }

    #[test]
    fn gitignore_and_reflectignore_prune_without_a_repository() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, ".gitignore", "generated/\n");
        write(root, ".reflectignore", "drafts/\n");
        write(root, "generated/api.md", "generated");
        write(root, "drafts/wip.md", "draft");
        write(root, "notes/a.md", "a");

        assert_eq!(note_paths(root), vec!["notes/a.md"]);
    }

    #[test]
    fn dependency_trees_and_tagged_caches_are_pruned_by_default() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "node_modules/pkg/README.md", "dep");
        write(root, "target/doc/index.md", "cache");
        write(
            root,
            "target/CACHEDIR.TAG",
            "Signature: 8a477f597d28d172789f06886806bc55\n",
        );
        write(root, "Target Practice/notes.md", "keep");
        write(root, "vendor/notes.md", "keep too");
        write(root, "notes/a.md", "a");

        let catalog = walk_catalog(root);
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            notes,
            vec!["Target Practice/notes.md", "notes/a.md", "vendor/notes.md"]
        );
        assert!(
            catalog.skipped >= 2,
            "node_modules and target must be counted"
        );
    }
}
