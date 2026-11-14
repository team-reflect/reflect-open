//! iCloud and mobile storage command arguments and results.

use serde::{Deserialize, Serialize};

use crate::FileChange;

/// The storage locations available to the mobile graph, as the onboarding
/// screen and `GraphProvider` consume them.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct MobileStorageInfo {
    /// The app-sandbox `Documents/` directory — always available, never
    /// synced. iOS container paths embed a UUID that changes across
    /// restore/update, so callers must never persist this absolute path.
    pub local_root: String,
    /// The container's `Documents/` directory when iCloud Drive is usable
    /// (entitled build + signed-in account) — where a new graph directory
    /// is created. `None` when signed out or the platform has no iCloud.
    /// Same rule as `local_root`: derive fresh, never persist.
    pub icloud_documents_root: Option<String>,
    /// Every existing graph directory inside the container (name-sorted,
    /// same listing as desktop's `icloud_status`) — onboarding and the
    /// graph switcher list them. Best-effort: content still syncing down at
    /// first launch can grow this later. The persisted selector is the
    /// graph's *name*, never these absolute paths.
    pub icloud_graph_roots: Vec<String>,
}

/// iCloud availability as desktop onboarding and settings consume it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IcloudStatus {
    /// True when the app can reach its iCloud Drive container (entitled
    /// build, signed-in account). Dev builds without the provisioning
    /// profile honestly report `false`.
    pub available: bool,
    /// The container's `Documents/` directory when available.
    pub documents_root: Option<String>,
    /// Every existing graph inside the container (name-sorted) — the
    /// returning-user fast path: onboarding lists them to open alongside
    /// creating a fresh one. Same rule as every container path: derive
    /// fresh, never persist.
    pub existing_graph_roots: Vec<String>,
}

/// What one sweep did.
#[derive(Debug, Default, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IcloudSweepOutcome {
    /// Every file the sweep changed on disk — reindex these directly.
    pub changed: Vec<FileChange>,
    /// Graph-relative paths of the conflict copies the sweep wrote.
    pub copies: Vec<String>,
    /// Conflicts resolved without user interaction.
    pub auto_resolved: u32,
}

/// How much of the graph a sweep checks for unresolved versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum SweepScope {
    /// Check every note, and run the store-housekeeping passes. Used on
    /// resume, adoption baseline, and any sweep without a live watch.
    Full,
    /// Restrict the per-note `NSFileVersion` checks to the paths the live
    /// metadata query flags as conflicted
    /// (`reflect_core::icloud::watch::conflicted_paths`). Each check is a
    /// synchronous round-trip to `fileproviderd`. Mobile's signal and arrival
    /// sweeps. Degrades to `Full` whenever the watch cannot answer completely.
    Candidates,
    /// Restrict the version checks to this sweep's `ingested_paths`. Desktop's
    /// arrival sweeps: no metadata watch runs there (see
    /// `reflect_core::icloud::watch`). A conflict version that never touches the
    /// working file is the `Full` sweep's job.
    Ingested,
}
