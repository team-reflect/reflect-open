//! Sync-conflict resolution (Plan 21).
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

pub mod archive;
mod frontmatter;
pub mod ladder;
pub mod markers;
mod merge3;
pub mod shadow;
mod total;
mod union;

use tauri::State;

use crate::error::AppResult;
use crate::fs::GraphState;

use self::archive::ArchivedVersion;

/// Command: the archived earlier versions of a note, newest first.
#[tauri::command]
pub async fn conflict_archive_list(
    path: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<Vec<ArchivedVersion>> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    crate::blocking::run_blocking(move || archive::list(&root, &path)).await
}

/// Command: the text of one archived version, named as the list returned it.
#[tauri::command]
pub async fn conflict_archive_read(
    path: String,
    name: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<String> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    crate::blocking::run_blocking(move || archive::read(&root, &path, &name)).await
}

/// One side of a two-way note conflict: full markdown plus the provenance
/// that drives ordering and diagnostics.
#[derive(Debug, Clone)]
pub struct ConflictSide {
    /// The complete note source (frontmatter + body).
    pub content: String,
    /// Display label: the saving device's name when the
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
    /// The sides carry identical content: nothing to write.
    AlreadyResolved,
    /// Auto-merged (or a deterministic winner was chosen) without losing text.
    Merged { content: String },
    /// Auto-merged, but the result may have dropped one side's text (the
    /// merge-loop breaker) or interleaved both sides' words (the last-resort
    /// merge).
    Reconciled { content: String },
}
