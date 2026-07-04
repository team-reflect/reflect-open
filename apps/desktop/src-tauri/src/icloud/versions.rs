//! The `NSFileVersion` surface: what iCloud knows about a file's unresolved
//! conflict versions, and the resolve/cleanup calls (Plan 21).
//!
//! When two devices edit apart, iCloud keeps one content as the current file
//! and stashes the others as conflict versions — full content in the local
//! version store, plus the saving device's name and modification date. The
//! sweep reads them through this module, resolves, then marks the versions
//! handled so iCloud stops reporting the conflict.

use std::path::PathBuf;

/// One unresolved conflict version of a file.
pub struct VersionRef {
    /// Where the version's content lives in the local version store. May be
    /// read like any file while the version is unresolved.
    pub store_path: PathBuf,
    /// The version's modification time (epoch ms) — shared metadata, the
    /// deterministic ordering key.
    pub modified_ms: u64,
    /// The saving device's name (`localizedNameOfSavingComputer`).
    pub device: Option<String>,
}

pub use platform::{mark_resolved, unresolved_versions};

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use super::VersionRef;
    use objc2_foundation::{NSFileVersion, NSString, NSURL};
    use std::path::Path;

    /// The file's unresolved conflict versions (empty when none, or when the
    /// file isn't under iCloud at all).
    pub fn unresolved_versions(abs: &Path) -> Vec<VersionRef> {
        let url = file_url(abs);
        let Some(versions) = NSFileVersion::unresolvedConflictVersionsOfItemAtURL(&url) else {
            return Vec::new();
        };
        versions.iter().filter_map(|version| describe(&version)).collect()
    }

    /// Mark every conflict version of `abs` resolved and drop the stale
    /// copies from the version store. Call strictly **after** the archive and
    /// the resolved write have landed. Best-effort: a failure leaves the
    /// versions unresolved and the next sweep retries.
    pub fn mark_resolved(abs: &Path) {
        let url = file_url(abs);
        if let Some(versions) = NSFileVersion::unresolvedConflictVersionsOfItemAtURL(&url) {
            for version in versions.iter() {
                version.setResolved(true);
            }
        }
        if let Err(err) = NSFileVersion::removeOtherVersionsOfItemAtURL_error(&url) {
            tracing::warn!(path = %abs.display(), %err, "failed to drop resolved iCloud versions");
        }
    }

    fn describe(version: &NSFileVersion) -> Option<VersionRef> {
        let store_path = version.URL().path()?.to_string();
        let modified_ms = version
            .modificationDate()
            .map(|date| {
                let seconds = date.timeIntervalSince1970();
                if seconds <= 0.0 {
                    0
                } else {
                    (seconds * 1000.0) as u64
                }
            })
            .unwrap_or(0);
        let device = version
            .localizedNameOfSavingComputer()
            .map(|name| name.to_string());
        Some(VersionRef {
            store_path: store_path.into(),
            modified_ms,
            device,
        })
    }

    fn file_url(abs: &Path) -> objc2::rc::Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&abs.to_string_lossy()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod platform {
    use super::VersionRef;
    use std::path::Path;

    /// No version store off Apple platforms.
    pub fn unresolved_versions(_abs: &Path) -> Vec<VersionRef> {
        Vec::new()
    }

    pub fn mark_resolved(_abs: &Path) {}
}
