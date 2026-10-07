//! Sync-conflict resolution (Plan 21).
//!
//! iCloud reports a concurrent edit as the current file plus one or more
//! unresolved `NSFileVersion`s. This module turns one such pair into a single
//! resolved note through a **deterministic ladder** ([`ladder::resolve`]):
//! identical/whitespace → three-way merge over the shadow base ([`shadow`]) →
//! structural rules (key-wise frontmatter, append-union) → labeled conflict
//! markers in the exact Plan 12 grammar, so everything downstream
//! (`detectConflictMarkers`, `has_conflict`, the protected view, the notice)
//! works unchanged whichever backend produced the conflict.
//!
//! **Determinism is a sync property, not a nicety**: both devices may resolve
//! the same conflict concurrently (each sees itself as the current version),
//! and only byte-identical outputs converge instead of ping-ponging. Every
//! rule therefore orders the two sides by `(modified_ms, content)` — data both
//! devices share — never by which side is local.
//!
//! Pure text in, text out: no iCloud types here. The platform half (version
//! discovery, archiving, applying results) lives in [`crate::icloud`] and the
//! sweep.

pub mod archive;
mod frontmatter;
pub mod ladder;
pub mod markers;
mod merge3;
pub mod shadow;
mod union;

use serde::Serialize;

use crate::error::AppResult;

/// Marker labels for a merge between this device's buffer and content that
/// arrived from elsewhere, when no device name is available.
pub(crate) const THIS_DEVICE: &str = "this device";
pub(crate) const OTHER_DEVICE: &str = "other device";

/// One side of a two-way note conflict: full markdown plus the provenance
/// that drives ordering and marker labels.
#[derive(Debug, Clone)]
pub struct ConflictSide {
    /// The complete note source (frontmatter + body).
    pub content: String,
    /// Display label for conflict markers — the saving device's name when the
    /// provider knows it (`NSFileVersion.localizedNameOfSavingComputer`).
    pub label: String,
    /// Last-modified time in epoch milliseconds. Shared metadata: both
    /// devices see the same value for the same version, which is what makes
    /// timestamp ordering deterministic across them.
    pub modified_ms: u64,
}

/// What the ladder decided for a conflict.
#[derive(Debug, PartialEq)]
pub enum Resolution {
    /// The sides carry identical content — nothing to write; the caller just
    /// marks the provider versions resolved.
    AlreadyResolved,
    /// Auto-merged (or a deterministic winner was chosen); write this content
    /// and mark the versions resolved. No user interaction needed.
    Merged { content: String },
    /// Overlapping edits: `content` carries labeled conflict markers. Write
    /// it and let the indexer flag `has_conflict` → "Needs review".
    Marked { content: String },
}

/// What a buffer-level merge produced, for the editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTextOutcome {
    pub content: String,
    /// False when `content` carries conflict markers.
    pub clean: bool,
}

/// Command: merge an open note's unsaved buffer (`ours`) with content that
/// arrived on disk (`theirs`) over the last content both derived from
/// (`base`), through the same ladder Git pulls and iCloud sweeps use, so the
/// editor resolves what they resolve: identical and whitespace-only
/// differences, disjoint edits, key-wise frontmatter, and (by `path`) the
/// daily-note append-union. Overlapping edits come back as labeled markers.
#[tauri::command]
pub fn conflict_merge_text(
    path: String,
    base: String,
    ours: String,
    theirs: String,
) -> AppResult<MergeTextOutcome> {
    let input = ladder::ConflictInput {
        path: &path,
        base: Some(&base),
        // Fixed stamps keep "ours" the first side, so markers read
        // `<<<<<<< this device` / `>>>>>>> other device` like a Git pull's.
        sides: (
            ConflictSide {
                content: ours.clone(),
                label: THIS_DEVICE.to_string(),
                modified_ms: 0,
            },
            ConflictSide {
                content: theirs,
                label: OTHER_DEVICE.to_string(),
                modified_ms: 1,
            },
        ),
        creation_collision: false,
        merge_loop_detected: false,
    };
    Ok(match ladder::resolve(input)? {
        Resolution::AlreadyResolved => MergeTextOutcome {
            content: ours,
            clean: true,
        },
        Resolution::Merged { content } => MergeTextOutcome {
            content,
            clean: true,
        },
        Resolution::Marked { content } => MergeTextOutcome {
            content,
            clean: false,
        },
    })
}

#[cfg(test)]
mod merge_text_tests {
    use super::*;

    fn merge(path: &str, base: &str, ours: &str, theirs: &str) -> MergeTextOutcome {
        conflict_merge_text(
            path.to_string(),
            base.to_string(),
            ours.to_string(),
            theirs.to_string(),
        )
        .unwrap()
    }

    #[test]
    fn disjoint_edits_merge_clean() {
        let out = merge("notes/a.md", "a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
        assert!(out.clean);
        assert_eq!(out.content, "A\nb\nC\n");
    }

    #[test]
    fn a_fold_and_an_external_append_merge_clean() {
        // The user report: folding a bullet (`-` → `+`) while a script
        // appended a line to the daily note.
        let base = "# 2026-10-07\n\n- a\n  - a1\n";
        let out = merge(
            "daily/2026-10-07.md",
            base,
            "# 2026-10-07\n\n+ a\n  - a1\n",
            "# 2026-10-07\n\n- a\n  - a1\n- from the script\n",
        );
        assert!(out.clean, "{}", out.content);
        assert_eq!(
            out.content,
            "# 2026-10-07\n\n+ a\n  - a1\n- from the script\n"
        );
    }

    #[test]
    fn both_appending_to_a_daily_note_unions() {
        let base = "# 2026-10-07\n\n- seed\n";
        let out = merge(
            "daily/2026-10-07.md",
            base,
            "# 2026-10-07\n\n- seed\n- mine\n",
            "# 2026-10-07\n\n- seed\n- theirs\n",
        );
        assert!(out.clean, "{}", out.content);
        assert!(out.content.contains("- mine\n") && out.content.contains("- theirs\n"));
    }

    #[test]
    fn overlapping_edits_come_back_marked_with_device_labels() {
        let out = merge("notes/a.md", "line\n", "mine\n", "theirs\n");
        assert!(!out.clean);
        assert!(
            out.content.contains("<<<<<<< this device"),
            "{}",
            out.content
        );
        assert!(
            out.content.contains(">>>>>>> other device"),
            "{}",
            out.content
        );
    }

    #[test]
    fn identical_content_is_clean() {
        let out = merge("notes/a.md", "old\n", "same\n", "same\n");
        assert!(out.clean);
        assert_eq!(out.content, "same\n");
    }
}
