//! Sidecar change metadata, without reading or materializing file contents.

use std::fs::Metadata;
use std::io;

/// Include identity and change time, so an equal-size rewrite followed by
/// restoring the modification time still invalidates the embedding checkpoint.
#[cfg(unix)]
pub(super) fn metadata_revision(metadata: &Metadata) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;

    Ok(format!(
        "{}:{:?}:{:?}:{}:{}:{}:{}",
        metadata.len(),
        metadata.modified()?,
        metadata.created().ok(),
        metadata.dev(),
        metadata.ino(),
        metadata.ctime(),
        metadata.ctime_nsec()
    ))
}

/// Size plus write and creation times. An in-place rewrite that keeps the size
/// and restores the write time goes unnoticed here; the manual description
/// backfill in Settings covers that case.
#[cfg(not(unix))]
pub(super) fn metadata_revision(metadata: &Metadata) -> io::Result<String> {
    Ok(format!(
        "{}:{:?}:{:?}",
        metadata.len(),
        metadata.modified()?,
        metadata.created().ok()
    ))
}
