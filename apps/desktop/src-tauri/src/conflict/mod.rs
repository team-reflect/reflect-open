//! Sync-conflict resolution (Plan 21).
//!
//! iCloud reports a concurrent edit as the current file plus one or more
//! unresolved `NSFileVersion`s. This module turns one such pair into a single
//! resolved note through a **deterministic ladder** ([`ladder::resolve`]):
//! identical/whitespace → three-way merge over the shadow base ([`shadow`]) →
//! structural rules (key-wise frontmatter, append-union) → a total word-level
//! merge ([`total`]). A resolution is always a usable note. Conflict markers
//! are still *detected* (`detectConflictMarkers`, `has_conflict`, the
//! protected view, the notice) for files older versions left behind, but
//! never written.
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
mod total;
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
    /// The saving device's name when the provider knows it
    /// (`NSFileVersion.localizedNameOfSavingComputer`); diagnostics only.
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
    /// Every line of `content` comes from one side unchanged (a clean
    /// three-way merge, a structural rule, or a deterministic winner).
    Merged { content: String },
    /// A side's text may be dropped (the loop breaker) or interleaved (the
    /// total merge). Callers archive both sides before they write this.
    Reconciled { content: String },
}

/// How a buffer-level merge ended.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeTextKind {
    /// `content` is the merge; nothing needs review.
    Clean,
    /// A side already carried markers (a pull wrote a conflicted note while
    /// the buffer was dirty). Nothing was merged: `content` is `theirs`, and
    /// the caller keeps `ours`. Nesting new markers around old ones would
    /// break the grammar the resolution UI splices by.
    Unmergeable,
}

/// What a buffer-level merge produced, for the editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTextOutcome {
    pub kind: MergeTextKind,
    pub content: String,
}

/// Command: merge an open note's unsaved buffer (`ours`) with content that
/// arrived on disk (`theirs`) over the last content both derived from
/// (`base`), through the same ladder Git pulls and iCloud sweeps use, so the
/// editor resolves what they resolve: identical and whitespace-only
/// differences, disjoint edits, key-wise frontmatter, and append-union. A
/// merge the ladder could only reconcile (overlapping edits) is reported as
/// [`MergeTextKind::Unmergeable`] here: this command has no graph root to
/// archive the buffer into, and the editor keeps the buffer beside the note
/// instead. An input that already carries markers is unmergeable as well.
#[tauri::command]
pub fn conflict_merge_text(
    _path: String,
    base: String,
    ours: String,
    theirs: String,
) -> AppResult<MergeTextOutcome> {
    let unmergeable = |theirs: String| MergeTextOutcome {
        kind: MergeTextKind::Unmergeable,
        content: theirs,
    };
    if markers::contains_conflict_markers(&ours) || markers::contains_conflict_markers(&theirs) {
        // The ladder's own rule for this (keep the newer side whole) is right
        // for two synced files and wrong for an unsaved buffer: it would
        // drop the user's edits and call the result clean.
        return Ok(unmergeable(theirs));
    }
    let input = ladder::ConflictInput {
        base: Some(&base),
        // Fixed stamps keep "ours" the first side.
        sides: (
            ConflictSide {
                content: ours.clone(),
                label: THIS_DEVICE.to_string(),
                modified_ms: 0,
            },
            ConflictSide {
                content: theirs.clone(),
                label: OTHER_DEVICE.to_string(),
                modified_ms: 1,
            },
        ),
        merge_loop_detected: false,
    };
    Ok(match ladder::resolve(input)? {
        Resolution::AlreadyResolved => MergeTextOutcome {
            kind: MergeTextKind::Clean,
            content: ours,
        },
        Resolution::Merged { content } => MergeTextOutcome {
            kind: MergeTextKind::Clean,
            content,
        },
        Resolution::Reconciled { .. } => unmergeable(theirs),
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
        assert_eq!(out.kind, MergeTextKind::Clean);
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
        assert_eq!(out.kind, MergeTextKind::Clean, "{}", out.content);
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
        assert_eq!(out.kind, MergeTextKind::Clean, "{}", out.content);
        assert!(out.content.contains("- mine\n") && out.content.contains("- theirs\n"));
    }

    #[test]
    fn overlapping_edits_are_unmergeable_until_the_editor_archives() {
        // The same line rewritten on both sides inside a note (the tails
        // overlap on "tail", so append-union cannot keep both).
        let out = merge(
            "notes/a.md",
            "a\nline\ntail\n",
            "a\nmine\ntail\n",
            "a\ntheirs\ntail\n",
        );
        assert_eq!(out.kind, MergeTextKind::Unmergeable);
        assert_eq!(out.content, "a\ntheirs\ntail\n");
    }

    #[test]
    fn whole_note_rewrites_on_both_sides_are_unmergeable_until_the_editor_archives() {
        // Neither side still starts with the base, so this is a rewrite, not
        // an append: the total merge would keep both, but its result needs
        // an archive first.
        let out = merge("notes/a.md", "line\n", "mine\n", "theirs\n");
        assert_eq!(out.kind, MergeTextKind::Unmergeable);
        assert_eq!(out.content, "theirs\n");
    }

    #[test]
    fn identical_content_is_clean() {
        let out = merge("notes/a.md", "old\n", "same\n", "same\n");
        assert_eq!(out.kind, MergeTextKind::Clean);
        assert_eq!(out.content, "same\n");
    }

    #[test]
    fn marked_remote_input_is_unmergeable_and_keeps_ours_out_of_content() {
        // A pull wrote a conflicted note while the buffer was dirty. The
        // ladder would keep the newer side whole; for a buffer that means
        // silently dropping the user's edit under a "clean" flag.
        let theirs = "<<<<<<< A\nremote A\n=======\nremote B\n>>>>>>> B\n";
        let out = merge("notes/a.md", "base\n", "my unsaved edit\n", theirs);
        assert_eq!(out.kind, MergeTextKind::Unmergeable);
        assert_eq!(out.content, theirs);
    }
}
