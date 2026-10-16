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
pub mod copy;
mod frontmatter;
pub mod ladder;
pub(crate) mod merge3;
pub mod shadow;
mod total;
mod union;

use tauri::State;

use crate::error::AppResult;
use crate::fs::{GraphState, NoteWriteOutcome};

use self::archive::ArchivedVersion;

/// Archive and ladder label for the side this app is writing.
pub(crate) const THIS_DEVICE: &str = "this device";
/// Archive and ladder label for the side found on disk.
pub(crate) const OTHER_DEVICE: &str = "other device";

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

/// Command: write an archived version back over the note. The text the note
/// holds is archived first.
#[tauri::command(async)]
pub fn conflict_archive_restore(
    path: String,
    name: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<NoteWriteOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    let outcome = restore_archived(&root, &path, &name, || {
        crate::fs::root_for_generation(&state, generation).map(drop)
    })?;
    crate::fs::invalidate_file_catalog(&state, &root);
    Ok(outcome)
}

/// Archive the note's text, then write the archived version `name` over it.
/// `still_current` runs under the graph lock before anything is read.
fn restore_archived(
    root: &std::path::Path,
    rel: &str,
    name: &str,
    still_current: impl FnOnce() -> AppResult<()>,
) -> AppResult<NoteWriteOutcome> {
    crate::fs::with_graph_lock(root, || {
        still_current()?;
        let archived = archive::read(root, rel, name)?;
        if let Some(current) = crate::fs::read_note_if_present(root, rel)? {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as u64);
            archive::archive_unless_in_history(
                root,
                rel,
                Some("before restore"),
                now_ms,
                current.as_bytes(),
            )?;
        }
        crate::fs::write_unchecked(root, rel, &archived)
    })
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
    /// Auto-merged, but the result may have dropped one side's text (a marked
    /// side, the merge-loop breaker) or interleaved both sides' words (the
    /// last-resort merge).
    Reconciled { content: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_archives_the_current_text_first() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "current text\n").unwrap();
        archive::archive_version(root, "notes/a.md", Some("Mac"), 5, b"archived text\n").unwrap();
        let name = archive::list(root, "notes/a.md").unwrap()[0].name.clone();

        let outcome = restore_archived(root, "notes/a.md", &name, || Ok(())).unwrap();

        assert_eq!(outcome.merged, None);
        assert!(outcome.modified_ms.is_some());
        assert_eq!(
            std::fs::read_to_string(root.join("notes/a.md")).unwrap(),
            "archived text\n"
        );
        assert!(crate::fs::own_writes::is_own(
            root,
            "notes/a.md",
            b"archived text\n"
        ));
        let versions = archive::list(root, "notes/a.md").unwrap();
        assert_eq!(versions.len(), 2);
        let before = versions
            .iter()
            .find(|version| version.device == "before-restore")
            .expect("the current text is archived");
        assert_eq!(
            archive::read(root, "notes/a.md", &before.name).unwrap(),
            "current text\n"
        );
    }
}
