use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, State};

/// Quit-time flush handshake (the save pipeline's last line of defense).
///
/// macOS ⌘Q requests app termination without closing windows first, so the
/// frontend's close-requested flush never runs and a debounced note save
/// still inside its window would be lost. The run loop (lib.rs) defers that
/// exit, arms this state with the number of live webviews, and emits
/// `app:quit-requested`; **every** window flushes its own buffers and calls
/// `quit_confirm`, and the last confirmation exits for real. A counter, not
/// a flag: with secondary note windows open, the first window's confirm must
/// not kill the process while another is still mid-flush.
#[derive(Default)]
pub struct QuitState {
    /// Windows still owing a flush confirmation; 0 = no quit in flight.
    pending: AtomicUsize,
}

impl QuitState {
    /// Arm (or re-arm — a repeated ⌘Q restarts the handshake) for `windows`
    /// webviews. Clamped to at least one so the handshake can always conclude.
    pub fn arm(&self, windows: usize) {
        self.pending.store(windows.max(1), Ordering::SeqCst);
    }

    /// Whether a deferred quit is waiting on confirmations.
    pub fn armed(&self) -> bool {
        self.pending.load(Ordering::SeqCst) > 0
    }

    /// Record one window's confirmation (or its destruction — a dead window
    /// can no longer confirm). True when it was the last one owed.
    pub fn confirm_one(&self) -> bool {
        let previous = self
            .pending
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                count.checked_sub(1)
            });
        matches!(previous, Ok(1))
    }
}

/// Confirm a deferred quit for the calling window: the frontend has flushed.
/// The last owed confirmation exits immediately.
#[tauri::command]
pub fn quit_confirm(app: AppHandle, state: State<'_, QuitState>) {
    if state.confirm_one() {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arms_per_window_and_concludes_on_the_last_confirm() {
        let state = QuitState::default();
        assert!(!state.armed());
        state.arm(2);
        assert!(state.armed());
        assert!(!state.confirm_one()); // first window: one still owed
        assert!(state.confirm_one()); // last window: exit now
        assert!(!state.armed());
    }

    #[test]
    fn confirming_without_an_armed_quit_is_inert() {
        let state = QuitState::default();
        assert!(!state.confirm_one());
        assert!(!state.armed());
    }

    #[test]
    fn arming_clamps_to_at_least_one_window() {
        let state = QuitState::default();
        state.arm(0);
        assert!(state.confirm_one());
    }

    #[test]
    fn rearming_restarts_the_handshake() {
        let state = QuitState::default();
        state.arm(2);
        assert!(!state.confirm_one());
        state.arm(2); // second ⌘Q while one confirm is already in
        assert!(!state.confirm_one());
        assert!(state.confirm_one());
    }
}
