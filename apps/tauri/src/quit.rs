use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, State};

/// Quit-time flush handshake (the save pipeline's last line of defense).
///
/// macOS ⌘Q requests app termination without closing windows first, so the
/// frontend's close-requested flush never runs and a debounced note save
/// still inside its window would be lost. The run loop (lib.rs) defers that
/// exit, arms this state with the labels of the live webviews, and emits
/// `app:quit-requested`; **every** window flushes its own buffers and calls
/// `quit_confirm`, and settling the last owed label exits for real.
///
/// Obligations are tracked **per window label**, not as a counter: a window
/// that confirms and is then destroyed must count once, and a repeated ⌘Q's
/// re-confirmations must not double-spend one window's obligation while
/// another is still mid-flush.
#[derive(Default)]
pub struct QuitState {
    /// Labels of webviews still owing a flush confirmation; empty = no quit
    /// in flight.
    pending: Mutex<HashSet<String>>,
}

impl QuitState {
    fn lock(&self) -> MutexGuard<'_, HashSet<String>> {
        // The set is valid whatever a poisoning panic interrupted — recover
        // it rather than wedge the quit path forever.
        self.pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Arm (or re-arm — a repeated ⌘Q restarts the handshake) for `windows`.
    pub fn arm(&self, windows: impl IntoIterator<Item = String>) {
        let mut pending = self.lock();
        pending.clear();
        pending.extend(windows);
    }

    /// Whether a deferred quit is waiting on confirmations. Window creation
    /// checks this: a webview born mid-handshake would never join the
    /// pending set, and the armed windows' confirms would exit underneath it.
    pub fn armed(&self) -> bool {
        !self.lock().is_empty()
    }

    /// Settle one window's obligation — its flush confirmed, or the window
    /// was destroyed and can no longer confirm. True when it was the last
    /// one owed; idempotent per label, so a confirm followed by a destroy
    /// (or a re-⌘Q double confirm) can never spend two obligations.
    pub fn settle(&self, label: &str) -> bool {
        let mut pending = self.lock();
        pending.remove(label) && pending.is_empty()
    }
}

/// Confirm a deferred quit for the calling window: its frontend has flushed.
/// Settling the last owed window exits immediately.
#[tauri::command]
pub fn quit_confirm(window: tauri::WebviewWindow, app: AppHandle, state: State<'_, QuitState>) {
    if state.settle(window.label()) {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arms_per_window_and_concludes_on_the_last_settle() {
        let state = QuitState::default();
        state.arm(["main".into(), "note-a".into()]);
        assert!(!state.settle("main")); // one still owed
        assert!(state.settle("note-a")); // last one: exit now
        assert!(!state.settle("main")); // handshake concluded — nothing owed
    }

    #[test]
    fn one_window_cannot_spend_two_obligations() {
        let state = QuitState::default();
        state.arm(["main".into(), "note-a".into()]);
        assert!(!state.settle("main")); // flush confirmed
        assert!(!state.settle("main")); // destroyed right after — still owed note-a
        assert!(state.settle("note-a"));
    }

    #[test]
    fn settling_without_an_armed_quit_is_inert() {
        let state = QuitState::default();
        assert!(!state.settle("main"));
    }

    #[test]
    fn unknown_labels_never_conclude_the_handshake() {
        let state = QuitState::default();
        state.arm(["main".into()]);
        assert!(!state.settle("note-b")); // not owed — e.g. opened after arming
        assert!(state.settle("main"));
    }

    #[test]
    fn rearming_restarts_the_handshake() {
        let state = QuitState::default();
        state.arm(["main".into(), "note-a".into()]);
        assert!(!state.settle("main"));
        state.arm(["main".into(), "note-a".into()]); // second ⌘Q
        assert!(!state.settle("main")); // re-confirm spends main's NEW obligation once
        assert!(state.settle("note-a"));
    }
}
