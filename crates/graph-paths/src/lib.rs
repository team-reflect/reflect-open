//! Shared graph-relative path policy for Reflect's native surfaces.
//!
//! Markdown can live anywhere in an opened vault. The durable boundary is
//! deliberately lexical: callers pass a graph-relative path, and this module
//! rejects hidden/traversal components before classifying it. Filesystem walks
//! must still skip symlinks separately because a lexical path cannot reveal
//! what an entry points at.

use std::path::{Component, Path, PathBuf};

/// Root trees reserved for Reflect-managed attachments and recordings.
/// Markdown under either tree is content, not a note.
pub const RESERVED_NOTE_TREES: [&str; 2] = ["assets", "audio-memos"];

/// Obsidian-compatible local attachment formats supported by Reflect.
pub const ATTACHMENT_EXTENSIONS: [&str; 20] = [
    "3gp", "avif", "bmp", "flac", "gif", "jpeg", "jpg", "m4a", "mkv", "mov", "mp3", "mp4", "ogg",
    "ogv", "pdf", "png", "svg", "wav", "webm", "webp",
];

/// The kind of graph content represented by a safe relative path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphPathKind {
    Note,
    Attachment,
}

/// Classify a normalized graph-relative path.
///
/// Notes require an exactly lowercase `.md` suffix. Attachments match their
/// extension case-insensitively. Absolute paths, traversal components, and any
/// dot-prefixed component are rejected.
pub fn classify(path: &Path) -> Option<GraphPathKind> {
    let components = visible_components(path)?;
    classify_components(&components)
}

/// Classify a forward-slashed path crossing an IPC or fixture boundary.
///
/// Unlike [`Path::components`], this deliberately rejects redundant separators
/// and `.` components instead of normalizing them. There is one canonical wire
/// representation, shared with TypeScript, on every platform.
pub fn classify_normalized(path: &str) -> Option<GraphPathKind> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || has_windows_drive_prefix(path)
    {
        return None;
    }
    let components: Vec<&str> = path.split('/').collect();
    if components
        .iter()
        .any(|component| component.is_empty() || component.starts_with('.'))
    {
        return None;
    }
    classify_components(&components)
}

fn classify_components(components: &[&str]) -> Option<GraphPathKind> {
    let first = *components.first()?;
    let file_name = *components.last()?;
    let (_, extension) = file_name.rsplit_once('.')?;
    if extension == "md" && !RESERVED_NOTE_TREES.contains(&first) {
        return Some(GraphPathKind::Note);
    }
    ATTACHMENT_EXTENSIONS
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        .then_some(GraphPathKind::Attachment)
}

/// Whether a path is an eligible Markdown note.
pub fn is_note(path: &Path) -> bool {
    classify(path) == Some(GraphPathKind::Note)
}

/// Whether a path is a supported local attachment.
pub fn is_attachment(path: &Path) -> bool {
    classify(path) == Some(GraphPathKind::Attachment)
}

/// Whether a graph-relative directory can contain eligible notes.
///
/// Walkers call this before descending, pruning hidden and reserved trees at
/// their root instead of traversing them and filtering every leaf.
pub fn may_contain_notes(path: &Path) -> bool {
    if !is_safe_visible_relative(path) {
        return false;
    }
    path.components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
        .is_some_and(|first| !RESERVED_NOTE_TREES.contains(&first))
}

/// Whether every path component is a visible, normal relative component.
pub fn is_safe_visible_relative(path: &Path) -> bool {
    visible_components(path).is_some()
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

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn visible_components(path: &Path) -> Option<Vec<&str>> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    let components: Vec<&str> = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .filter(|component| !component.starts_with('.') && !component.contains('\\')),
            _ => None,
        })
        .collect::<Option<_>>()?;
    if components
        .first()
        .is_some_and(|first| has_windows_drive_prefix(first))
    {
        return None;
    }
    Some(components)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        classify, classify_normalized, evicted_logical_path, eviction_placeholder,
        is_safe_visible_relative, GraphPathKind,
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
            assert_eq!(
                classify_normalized(&fixture.path),
                expected,
                "{}",
                fixture.path
            );
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

    #[test]
    fn native_paths_reject_drive_relative_prefixes() {
        let drive_relative = Path::new("C:relative.md");
        assert_eq!(classify(drive_relative), None);
        assert!(!is_safe_visible_relative(drive_relative));
    }
}
