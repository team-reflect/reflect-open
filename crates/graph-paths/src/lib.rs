//! Shared graph-relative path policy for Reflect's native surfaces.
//!
//! Markdown can live anywhere in an opened vault. The durable boundary is
//! deliberately lexical, with **one canonical representation**: a
//! forward-slashed wire path, shared with TypeScript on every platform.
//! Native paths must go through [`wire_path`] first, so redundant separators,
//! `.` components, and non-UTF-8 names fail closed instead of classifying
//! differently per entry point. Filesystem walks must still skip symlinks
//! separately because a lexical path cannot reveal what an entry points at.

use std::path::{Component, Path, PathBuf};

mod walk;

pub use walk::{has_pruned_component, walk_catalog, FileCatalog, FileEntry, REFLECT_IGNORE_FILE};

/// Root trees reserved for Reflect-managed attachments and recordings.
/// Markdown under either tree is content, not a note.
pub const RESERVED_NOTE_TREES: [&str; 2] = ["assets", "audio-memos"];

/// Obsidian-compatible local attachment formats supported by Reflect.
pub const ATTACHMENT_EXTENSIONS: [&str; 20] = [
    "3gp", "avif", "bmp", "flac", "gif", "jpeg", "jpg", "m4a", "mkv", "mov", "mp3", "mp4", "ogg",
    "ogv", "pdf", "png", "svg", "wav", "webm", "webp",
];

/// The kind of graph content represented by a safe relative wire path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphPathKind {
    Note,
    Attachment,
}

/// Classify a graph-relative wire path.
///
/// Notes require an exactly lowercase `.md` suffix. Attachments match their
/// extension case-insensitively (ASCII only, mirroring the TypeScript side).
/// Absolute paths, traversal components, redundant separators, and any
/// dot-prefixed component are rejected rather than normalized.
pub fn classify(path: &str) -> Option<GraphPathKind> {
    let components = wire_components(path)?;
    let first = *components.first()?;
    let file_name = *components.last()?;
    let (_, extension) = file_name.rsplit_once('.')?;
    if extension == "md" && !is_reserved_note_tree(first) {
        return Some(GraphPathKind::Note);
    }
    ATTACHMENT_EXTENSIONS
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        .then_some(GraphPathKind::Attachment)
}

/// Whether a wire path is an eligible Markdown note.
pub fn is_note(path: &str) -> bool {
    classify(path) == Some(GraphPathKind::Note)
}

/// Whether a wire path is a supported local attachment.
pub fn is_attachment(path: &str) -> bool {
    classify(path) == Some(GraphPathKind::Attachment)
}

/// Whether every component of a wire path is a visible, normal relative
/// component. [`classify`] implies this; walkers use it alone for paths that
/// are tracked without being notes (e.g. `audio-memos/` recordings).
pub fn is_safe_visible(path: &str) -> bool {
    wire_components(path).is_some()
}

/// Whether a graph-relative wire directory can contain eligible notes.
///
/// Walkers call this before descending, pruning hidden and reserved trees at
/// their root instead of traversing them and filtering every leaf.
pub fn may_contain_notes(path: &str) -> bool {
    match wire_components(path) {
        Some(components) => components
            .first()
            .is_some_and(|first| !is_reserved_note_tree(first)),
        None => false,
    }
}

/// Convert a native relative path into its canonical wire form.
///
/// Fails closed on everything that cannot round-trip the IPC boundary:
/// non-UTF-8 names, backslashes inside a component, hidden components, and
/// drive-letter prefixes. There is deliberately no lossy fallback — a file
/// this rejects is never listed, never watched, and never resolvable.
pub fn wire_path(rel: &Path) -> Option<String> {
    let mut out = String::new();
    for component in rel.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if part.starts_with('.') || part.contains(['/', '\\']) {
            return None;
        }
        if out.is_empty() && has_windows_drive_prefix(part) {
            return None;
        }
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(part);
    }
    (!out.is_empty()).then_some(out)
}

/// The logical file name represented by an iCloud eviction placeholder.
pub fn icloud_placeholder_target(file_name: &str) -> Option<&str> {
    let name = file_name.strip_prefix('.')?.strip_suffix(".icloud")?;
    (!name.is_empty()).then_some(name)
}

/// If `path` is an iCloud eviction placeholder, return the sibling path of
/// the logical file it stands in for.
pub fn evicted_logical_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let logical = icloud_placeholder_target(name)?;
    Some(path.with_file_name(logical))
}

/// The iCloud eviction-placeholder sibling for a logical file path.
pub fn eviction_placeholder(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    Some(path.with_file_name(format!(".{name}.icloud")))
}

/// The kernel's dataless-file flag (`SF_DATALESS` in `<sys/stat.h>`): set on
/// files whose bytes have been evicted to a file provider (modern macOS
/// iCloud Drive). The file keeps its real path, logical size, and mtime, but
/// any read blocks while `fileproviderd` re-materializes the bytes — so bulk
/// passes must check this before reading, or a single pass turns into
/// thousands of serial on-demand downloads.
///
/// Checking `st_flags` for `SF_DATALESS` is Apple's documented detection for
/// POSIX-level access (TN3150, "Getting ready for dataless files":
/// <https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files>);
/// the flag is also documented in `chflags(2)`, which marks it (with
/// `UF_COMPRESSED`) as kernel-internal: userland can observe but never set
/// it. The value is public ABI from the macOS SDK's `<sys/stat.h>` (also in
/// Apple's open-source XNU, `bsd/sys/stat.h`), spelled out here because the
/// `libc` crate does not bind it yet.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const SF_DATALESS: u32 = 0x4000_0000;

/// Pure half of [`is_dataless`], split out because userland cannot *set*
/// `SF_DATALESS` (it is kernel-owned), so only the flag decode is unit
/// testable. Deliberately not `st_blocks == 0`: transparently-compressed
/// (decmpfs) files also allocate zero data blocks, and misreading one as
/// evicted would silently drop it from indexing forever.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn dataless_flags(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

/// True when `meta` describes an evicted dataless file (bytes remote, path
/// and stat intact). Always `false` off Apple platforms.
#[cfg(target_os = "macos")]
pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    dataless_flags(meta.st_flags())
}

/// True when `meta` describes an evicted dataless file (bytes remote, path
/// and stat intact). Always `false` off Apple platforms.
#[cfg(target_os = "ios")]
pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
    use std::os::ios::fs::MetadataExt;
    dataless_flags(meta.st_flags())
}

/// True when `meta` describes an evicted dataless file (bytes remote, path
/// and stat intact). Always `false` off Apple platforms.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn is_dataless(_meta: &std::fs::Metadata) -> bool {
    false
}

fn is_reserved_note_tree(component: &str) -> bool {
    RESERVED_NOTE_TREES
        .iter()
        .any(|reserved| component.eq_ignore_ascii_case(reserved))
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn wire_components(path: &str) -> Option<Vec<&str>> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || has_windows_drive_prefix(path)
    {
        return None;
    }
    let components: Vec<&str> = path.split('/').collect();
    components
        .iter()
        .all(|component| !component.is_empty() && !component.starts_with('.'))
        .then_some(components)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        classify, evicted_logical_path, eviction_placeholder, is_safe_visible, wire_path,
        GraphPathKind,
    };
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        path: String,
        kind: Option<String>,
    }

    #[test]
    fn shared_fixture_corpus_matches_rust_policy() {
        let raw = include_str!("../../../fixtures/graph-path-classification.json");
        let fixtures: Vec<Fixture> = serde_json::from_str(raw).expect("valid fixture corpus");
        for fixture in fixtures {
            let expected = match fixture.kind.as_deref() {
                Some("note") => Some(GraphPathKind::Note),
                Some("attachment") => Some(GraphPathKind::Attachment),
                None => None,
                Some(other) => panic!("unknown fixture kind {other}"),
            };
            assert_eq!(classify(&fixture.path), expected, "{}", fixture.path);
        }
    }

    #[test]
    fn wire_path_produces_the_canonical_form_or_nothing() {
        assert_eq!(
            wire_path(Path::new("Projects/deep/plan.md")).as_deref(),
            Some("Projects/deep/plan.md")
        );
        // `Path::components` normalizes `.` and doubled separators away; the
        // canonical form is what a strict wire parser accepts.
        assert_eq!(
            wire_path(Path::new("Projects/./plan.md")).as_deref(),
            Some("Projects/plan.md")
        );
        assert!(is_safe_visible(
            &wire_path(Path::new("Projects//plan.md")).unwrap()
        ));
        assert_eq!(wire_path(Path::new("")), None);
        assert_eq!(wire_path(Path::new("/absolute.md")), None);
        assert_eq!(wire_path(Path::new("../outside.md")), None);
        assert_eq!(wire_path(Path::new(".hidden/note.md")), None);
        assert_eq!(wire_path(Path::new("C:relative.md")), None);
        #[cfg(unix)]
        assert_eq!(wire_path(Path::new("a\\b.md")), None);
        #[cfg(unix)]
        {
            use std::ffi::OsStr;
            use std::os::unix::ffi::OsStrExt;
            let non_utf8 = Path::new(OsStr::from_bytes(b"caf\xC3.md"));
            assert_eq!(wire_path(non_utf8), None);
        }
    }

    #[test]
    fn maps_icloud_placeholders_in_both_directions() {
        let logical = Path::new("Projects/plan.md");
        let placeholder = Path::new("Projects/.plan.md.icloud");
        assert_eq!(eviction_placeholder(logical).as_deref(), Some(placeholder));
        assert_eq!(evicted_logical_path(placeholder).as_deref(), Some(logical));
        assert_eq!(evicted_logical_path(logical), None);
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn dataless_decodes_only_the_kernel_flag() {
        use super::{dataless_flags, SF_DATALESS};
        assert!(dataless_flags(SF_DATALESS));
        assert!(dataless_flags(SF_DATALESS | 0x1));
        assert!(!dataless_flags(0));
        // Other BSD flags (UF_HIDDEN, UF_COMPRESSED, …) are not eviction.
        assert!(!dataless_flags(0x8000 | 0x20));
    }

    #[test]
    fn a_regular_file_is_not_dataless() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"hello").unwrap();
        assert!(!super::is_dataless(&std::fs::metadata(&path).unwrap()));
    }

    #[test]
    fn placeholder_names_parse_only_the_icloud_shape() {
        use super::icloud_placeholder_target;
        assert_eq!(icloud_placeholder_target(".a.md.icloud"), Some("a.md"));
        assert_eq!(icloud_placeholder_target(".noext.icloud"), Some("noext"));
        // Not placeholders: no leading dot, no suffix, or nothing in between.
        assert_eq!(icloud_placeholder_target("a.md.icloud"), None);
        assert_eq!(icloud_placeholder_target(".a.md"), None);
        assert_eq!(icloud_placeholder_target(".icloud"), None);
    }
}
