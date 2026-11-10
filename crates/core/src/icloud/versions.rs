//! The `NSFileVersion` surface: what iCloud knows about a file's unresolved
//! conflict versions, and the resolve/cleanup calls.
//!
//! When two devices edit apart, iCloud keeps one content as the current file
//! and stashes the others as conflict versions — full content in the local
//! version store, plus its modification date. The sweep reads them through
//! this module, resolves, then marks the versions handled so iCloud stops
//! reporting the conflict.

use std::path::PathBuf;

/// One unresolved conflict version of a file.
pub struct VersionRef {
    /// Where the version's content lives in the local version store. May be
    /// read like any file while the version is unresolved.
    pub store_path: PathBuf,
    /// The version's modification time (epoch ms) — shared metadata, the
    /// deterministic ordering key.
    pub modified_ms: u64,
}

/// A file's unresolved conflict versions, plus whether the listing is
/// **complete**. `NSFileVersion.URL` can hand back a URL with no path; such a
/// version can't be read, so the sweep must not resolve the file.
pub struct VersionScan {
    pub versions: Vec<VersionRef>,
    pub complete: bool,
}

impl VersionScan {
    /// No conflict versions at all (the common case, and the off-Apple stub).
    pub fn none(&self) -> bool {
        self.versions.is_empty() && self.complete
    }
}

pub use platform::{current_version_modified_ms, mark_resolved, unresolved_versions};

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use super::{VersionRef, VersionScan};
    use objc2_foundation::{NSDate, NSFileVersion, NSString, NSURL};
    use std::path::{Path, PathBuf};

    /// The file's unresolved conflict versions (empty when none, or when the
    /// file isn't under iCloud at all).
    pub fn unresolved_versions(abs: &Path) -> VersionScan {
        let url = file_url(abs);
        let Some(listed) = NSFileVersion::unresolvedConflictVersionsOfItemAtURL(&url) else {
            return VersionScan {
                versions: Vec::new(),
                complete: true,
            };
        };
        let mut versions = Vec::new();
        let mut complete = true;
        for version in listed.iter() {
            match describe(&version) {
                Some(described) => versions.push(described),
                None => {
                    tracing::warn!(
                        path = %abs.display(),
                        "iCloud conflict version has no readable store path; deferring the file"
                    );
                    complete = false;
                }
            }
        }
        VersionScan { versions, complete }
    }

    /// The on-disk content's modification time (epoch ms) as the **version
    /// store** records it. This is the same shared metadata another device
    /// sees for this content as a *conflict* version, so ordering the
    /// working-copy side by it — rather than by the filesystem mtime, which
    /// iCloud does not propagate bit-exactly — keeps the ladder's side order
    /// (and therefore its output bytes) identical across devices. `None`
    /// when the file has no current version (not under iCloud) or no date.
    pub fn current_version_modified_ms(abs: &Path) -> Option<u64> {
        let url = file_url(abs);
        let version = NSFileVersion::currentVersionOfItemAtURL(&url)?;
        version.modificationDate().map(|date| date_ms(&date))
    }

    /// Mark the conflict versions of `abs` whose store paths are in
    /// `handled` resolved, then drop the stale copies from the version store
    /// unless a version the sweep never saw is still unresolved. Call
    /// strictly **after** the resolved write has landed. Best-effort: the next
    /// sweep retries what is left.
    pub fn mark_resolved(abs: &Path, handled: &[PathBuf]) {
        let url = file_url(abs);
        let Some(listed) = NSFileVersion::unresolvedConflictVersionsOfItemAtURL(&url) else {
            return;
        };
        let mut all_handled = true;
        for version in listed.iter() {
            if store_path(&version).is_some_and(|path| handled.contains(&path)) {
                version.setResolved(true);
            } else {
                all_handled = false;
            }
        }
        if !all_handled {
            return;
        }
        if let Err(err) = NSFileVersion::removeOtherVersionsOfItemAtURL_error(&url) {
            tracing::warn!(path = %abs.display(), %err, "failed to drop resolved iCloud versions");
        }
    }

    fn describe(version: &NSFileVersion) -> Option<VersionRef> {
        let store_path = store_path(version)?;
        let modified_ms = version
            .modificationDate()
            .map(|date| date_ms(&date))
            .unwrap_or(0);
        Some(VersionRef {
            store_path,
            modified_ms,
        })
    }

    fn store_path(version: &NSFileVersion) -> Option<PathBuf> {
        Some(version.URL().path()?.to_string().into())
    }

    /// `NSDate` → epoch ms, clamped at zero. Both the conflict-version and
    /// current-version keys convert through here so the two sides of a pair
    /// can never round differently.
    fn date_ms(date: &NSDate) -> u64 {
        let seconds = date.timeIntervalSince1970();
        if seconds <= 0.0 {
            0
        } else {
            (seconds * 1000.0) as u64
        }
    }

    fn file_url(abs: &Path) -> objc2::rc::Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&abs.to_string_lossy()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod platform {
    use super::VersionScan;
    use std::path::{Path, PathBuf};

    /// No version store off Apple platforms.
    pub fn unresolved_versions(_abs: &Path) -> VersionScan {
        VersionScan {
            versions: Vec::new(),
            complete: true,
        }
    }

    pub fn current_version_modified_ms(_abs: &Path) -> Option<u64> {
        None
    }

    pub fn mark_resolved(_abs: &Path, _handled: &[PathBuf]) {}
}
