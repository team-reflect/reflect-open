//! OS advisory lease files under `.reflect/`: a locked file proves its owning
//! process is still alive, so another Reflect process can fail closed.

use std::fs::{self, File};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{AppError, AppResult};

/// A process-unique session token usable as a lease file name.
pub(crate) fn new_session_id() -> String {
    static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
    let epoch_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{epoch_nanos}-{}",
        std::process::id(),
        NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
    )
}

/// Open or create a lease file, refusing anything that is not a real file.
pub(crate) fn open_real_lease_file(path: &Path) -> AppResult<File> {
    loop {
        match open_existing_real_lease_file(path)? {
            Some(file) => return Ok(file),
            None => match fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(file) => return Ok(file),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            },
        }
    }
}

/// Open an existing lease file (`None` when absent), refusing symlinks and
/// anything else that is not a real file.
pub(crate) fn open_existing_real_lease_file(path: &Path) -> AppResult<Option<File>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let file = fs::OpenOptions::new().read(true).write(true).open(path)?;
            if !file.metadata()?.is_file() {
                return Err(AppError::traversal(format!(
                    "lease path must be a real file: {}",
                    path.display()
                )));
            }
            Ok(Some(file))
        }
        Ok(_) => Err(AppError::traversal(format!(
            "lease path must be a real file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
