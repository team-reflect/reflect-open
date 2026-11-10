//! Mobile stand-in for the file watcher (Plan 19): there is no watcher on
//! iOS/Android by design — nothing else writes the app sandbox, and local
//! writes notify the frontend in-process (`emitFileChanges`) instead. The
//! commands stay registered so the IPC surface is identical on every
//! platform.
//!
//! Both commands are deliberate no-ops, not errors. The command contract is
//! "start/stop platform file watching, if the platform has any" — and the
//! shared graph-index lifecycle (`graph-index.ts`) awaits `watch_start`
//! between subscribing to index changes and going live, so an error here
//! would tear that subscription down and cut the in-process event path off
//! from the indexer. Succeeding with nothing to do is the honest answer.

use reflect_types::AppResult;

use crate::Core;

/// Unit stand-in for the desktop watcher state, so [`Core`] holds the same
/// type name on every platform.
#[derive(Default)]
pub struct WatcherState;

impl Core {
    /// No-op: mobile has no platform watcher to start. `index:changed` events
    /// never come from the shell here — local writes notify in-process instead.
    pub fn watch_start(&self) -> AppResult<()> {
        Ok(())
    }

    /// No-op: stopping a watcher that never runs is trivially true.
    pub fn watch_stop(&self) -> AppResult<()> {
        Ok(())
    }
}
