//! One home for the async-command → blocking-pool hop.
//!
//! Sync Tauri commands run on the main thread — on iOS the thread that also
//! delivers touches — so any command that does real filesystem, SQLite, or
//! git work is declared `async` and runs its body here instead. The
//! `JoinError` arm only fires when the closure panics; the panic itself is
//! the bug, this just keeps it from poisoning the command layer silently.

use crate::error::{AppError, AppResult};

/// Run `task` on the blocking thread pool and await its result.
pub(crate) async fn run_blocking<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| AppError::io(format!("blocking task panicked: {err}")))?
}
