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
pub mod ladder;
pub mod markers;
pub mod shadow;
mod frontmatter;
mod merge3;
mod union;

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
