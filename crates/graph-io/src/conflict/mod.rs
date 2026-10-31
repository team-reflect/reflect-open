//! Sync-conflict resolution.
//!
//! iCloud reports a concurrent edit as the current file plus one or more
//! unresolved `NSFileVersion`s. This module turns one such pair into a single
//! resolved note through a **deterministic ladder** ([`ladder::resolve`]):
//! identical/whitespace → three-way merge over the shadow base ([`shadow`]) →
//! structural rules (key-wise frontmatter, append-union) → a word-level merge
//! that always yields text. The ladder never writes conflict markers.
//!
//! **Determinism is a sync property, not a nicety**: both devices may resolve
//! the same conflict concurrently (each sees itself as the current version),
//! and only byte-identical outputs converge instead of ping-ponging. Every
//! rule therefore orders the two sides by `(modified_ms, content)`, data both
//! devices share, never by which side is local.
//!
//! Pure text in, text out: no iCloud types here.

pub mod copy;
mod frontmatter;
pub mod ladder;
pub mod merge3;
pub mod shadow;
mod total;
mod union;

/// One side of a two-way note conflict: full markdown plus the modification
/// time that drives ordering.
#[derive(Debug, Clone)]
pub struct ConflictSide {
    /// The complete note source (frontmatter + body).
    pub content: String,
    /// Last-modified time in epoch milliseconds. Shared metadata: both
    /// devices see the same value for the same version, which is what makes
    /// timestamp ordering deterministic across them.
    pub modified_ms: u64,
}

/// What the ladder decided for a conflict.
#[derive(Debug, PartialEq)]
pub enum Resolution {
    /// The sides carry identical content: nothing to write.
    AlreadyResolved,
    /// Auto-merged (or a deterministic winner was chosen) without losing text.
    Merged { content: String },
    /// Auto-merged, but the result may have dropped one side's text (the
    /// merge-loop breaker) or interleaved both sides' words (the last-resort
    /// merge).
    Reconciled { content: String },
}
