//! The SQLite index session the shell's other modules share.

use crate::error::AppResult;

pub use reflect_index::IndexSession as IndexState;

/// The open index session's generation as a pure read, or `None` when no
/// index is open. The note-window bootstrap (`windows::window_bootstrap`)
/// adopts the session through this.
pub(crate) fn current_generation(index: &IndexState) -> AppResult<Option<u64>> {
    index.current_generation()
}
