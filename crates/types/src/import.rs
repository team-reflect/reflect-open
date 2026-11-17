//! The Reflect V1 import's result and progress.

use serde::Serialize;

/// Summary returned to the settings UI after an import completes.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct GraphImportSummary {
    /// Zip files newly written to the open graph.
    pub imported_files: usize,
    /// Zip files already present with identical bytes, left untouched.
    pub skipped_files: usize,
    /// Remote attachments now stored locally under `assets/` (whether newly
    /// written or already present from an earlier import).
    pub downloaded_assets: usize,
    /// Remote attachments that are permanently gone (4xx); their notes keep
    /// the remote link.
    pub failed_asset_downloads: usize,
    /// Zip files written under a `-2`-style suffixed name because their own
    /// name is held by a differing existing file — a genuine same-name file,
    /// or one the filesystem merely aliases to the same path
    /// (case-insensitive APFS folds `Füße.md`/`füsse.md`/`füße.md` together;
    /// the V1 export keeps them distinct notes). Renamed assets have the
    /// imported notes' `assets/…` links rewritten to the suffixed name.
    pub renamed_files: usize,
    /// Existing daily notes that gained the imported entry's body: the day
    /// already had a note with different content, so the import appends
    /// rather than duplicating the day under a suffixed name.
    pub merged_files: usize,
    /// Graph-relative paths written to the open graph (new files and merged
    /// daily notes).
    pub changed_paths: Vec<String>,
}

/// Which phase of the import a progress tick belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum GraphImportStage {
    /// Long remote downloads first.
    Downloading,
    /// Then fast local writes.
    Writing,
}

/// Progress of the running import, emitted to the frontend as
/// `import:progress` events.
#[derive(Clone, Copy, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct GraphImportProgress {
    pub stage: GraphImportStage,
    pub done: usize,
    pub total: usize,
}
