//! Sidecar change metadata, without reading or materializing file contents.

use std::fs::Metadata;
use std::io;
use std::path::Path;

/// Include identity and change time, so an equal-size rewrite followed by
/// restoring the modification time still invalidates the embedding checkpoint.
#[cfg(unix)]
pub(super) fn metadata_revision(_path: &Path, metadata: &Metadata) -> io::Result<String> {
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

/// Query Windows change time through an attributes-only handle; std metadata
/// exposes last-write and creation times, neither of which detects an in-place
/// rewrite when an external tool restores last-write time. Failed probes remain
/// retryable rather than treating unsupported filesystem metadata as unchanged.
#[cfg(windows)]
pub(super) fn metadata_revision(path: &Path, _metadata: &Metadata) -> io::Result<String> {
    use std::fs::File;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let file = File::options()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)?;
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: the live File owns the handle. FileBasicInfo writes exactly a
    // FILE_BASIC_INFO into the correctly sized/aligned initialized buffer.
    let basic_result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            std::ptr::from_mut(&mut basic).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if basic_result == 0 {
        return Err(io::Error::last_os_error());
    }
    if basic.ChangeTime == 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "filesystem does not expose a file change time",
        ));
    }
    let mut identity = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the same live handle and a valid output structure are passed to
    // the Win32 API; no data-read access is requested or performed.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut identity) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        identity.nFileSizeHigh,
        identity.nFileSizeLow,
        basic.LastWriteTime,
        basic.CreationTime,
        basic.ChangeTime,
        identity.dwVolumeSerialNumber,
        identity.nFileIndexHigh,
        identity.nFileIndexLow
    ))
}
