//! Wake-from-sleep catch-up (macOS).
//!
//! On desktop the `notify` FSEvents watcher is the *only* live source of
//! external content changes: the iCloud metadata watch deliberately does not
//! emit file events here (`emit_file_changes: false`), and the resume/focus
//! triggers only run conflict sweeps. A file that iCloud downloads while the
//! machine sleeps (Power Nap) or during the wake transition can miss FSEvents
//! delivery entirely — the process is suspended when the write lands — and
//! with no backstop the note stays stale until the next full reconcile, which
//! ordinarily means an app restart.
//!
//! This observer closes that gap: `NSWorkspaceDidWakeNotification` emits one
//! coarse `index:reconcile`, and the frontend answers with its ordinary full
//! reconcile pass (re-list, hash, repair — the same pass a structural watcher
//! change requests), which also surfaces stale iCloud placeholders for
//! targeted downloads. The frontend coalesces bursts, and the event is
//! ignored whenever no graph is open, so a spurious wake costs one no-op.

use std::ptr::NonNull;

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::NSNotification;
use tauri::Emitter;

/// Install the app-lifetime wake observer. Called once from
/// `RunEvent::Ready` (the main thread — where AppKit expects observer
/// registration, and the same spot the reveal fallback arms; `.setup()` is
/// avoided because Tauri stores a single setup callback and a second
/// registration would silently replace the first).
pub fn install(app: &tauri::AppHandle) {
    let app = app.clone();
    let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
        // Delivered on the main thread (workspace notifications post there;
        // no delivery queue is requested). `emit` is thread-safe and cheap —
        // the reconcile itself runs in the frontend's index lifecycle.
        let _ = app.emit(crate::watcher::RECONCILE_EVENT, ());
    });
    let workspace = NSWorkspace::sharedWorkspace();
    let center = workspace.notificationCenter();
    let token: Retained<AnyObject> = unsafe {
        msg_send![
            &center,
            addObserverForName: NSWorkspaceDidWakeNotification,
            object: Option::<&AnyObject>::None,
            queue: Option::<&AnyObject>::None,
            usingBlock: &*block
        ]
    };
    // The observer lives for the whole app run — leak the token rather than
    // house it in a static nobody reads (dropping it would not deregister
    // the observer anyway; only removeObserver does).
    std::mem::forget(token);
}
