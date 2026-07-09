//! iOS finite-length background execution assertions.
//!
//! UIKit may suspend the process shortly after it enters the background. A
//! suspension while SQLite or a file writer owns a lock is fatal (`0xdead10cc`),
//! so native write commands can hold a [`ScopedBackgroundTask`] and the mobile
//! frontend can bracket its whole background persistence flush through the two
//! commands below. Each path has an isolated registry; within either registry,
//! normal completion and UIKit's expiration callback race to remove the token,
//! and only the winner ends the native assertion.

#[cfg(any(target_os = "ios", test))]
use std::collections::HashMap;
#[cfg(any(target_os = "ios", test))]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
#[cfg(any(target_os = "ios", test))]
use std::sync::{Mutex, MutexGuard};

use tauri::State;

#[cfg(any(target_os = "ios", test))]
type NativeIdentifier = usize;

#[cfg(any(target_os = "ios", test))]
#[derive(Default)]
struct TaskRegistry {
    next_token: AtomicU64,
    tasks: Mutex<HashMap<String, Option<NativeIdentifier>>>,
}

#[cfg(not(any(target_os = "ios", test)))]
#[derive(Default)]
struct TaskRegistry;

#[cfg(any(target_os = "ios", test))]
impl TaskRegistry {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Option<NativeIdentifier>>> {
        self.tasks
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Reserve a token before asking UIKit for an identifier. The temporary
    /// `None` lets an unusually early expiration remove the reservation; the
    /// begin path then notices and immediately ends the identifier it received.
    fn reserve(&self) -> String {
        let sequence = self.next_token.fetch_add(1, Ordering::Relaxed) + 1;
        let token = format!("background-task-{sequence}");
        self.lock().insert(token.clone(), None);
        token
    }

    /// Attach UIKit's identifier unless expiration already consumed the token.
    fn activate(&self, token: &str, identifier: NativeIdentifier) -> bool {
        let mut tasks = self.lock();
        let Some(slot) = tasks.get_mut(token) else {
            return false;
        };
        *slot = Some(identifier);
        true
    }

    /// Remove a token and return its identifier, if UIKit had assigned one.
    fn take(&self, token: &str) -> Option<NativeIdentifier> {
        self.lock().remove(token).flatten()
    }

    fn cancel(&self, token: &str) {
        self.lock().remove(token);
    }
}

/// Process-wide native background assertions. Frontend and scoped native tasks
/// intentionally use separate registries: an IPC caller can never end a DB
/// assertion by guessing its predictable process-local token.
#[derive(Default)]
pub struct BackgroundTaskState {
    frontend: Arc<TaskRegistry>,
    scoped: Arc<TaskRegistry>,
}

impl BackgroundTaskState {
    fn begin_frontend(&self, name: &str) -> Option<String> {
        platform::begin(Arc::clone(&self.frontend), name)
    }

    fn end_frontend(&self, token: &str) {
        platform::end(&self.frontend, token);
    }
}

/// RAII assertion for native operations that may own a file or SQLite lock.
/// Expiration and `Drop` are idempotent through [`TaskRegistry::take`].
///
/// Current consumers are synchronous Tauri DB commands on iOS's main thread;
/// UIKit also invokes expiration handlers on that thread, so expiration cannot
/// end their assertion until the command returns and has released its SQLite
/// lock. Do not use this guard for background-thread work without adding an
/// expiration signal that cancels the operation before ending the assertion.
pub(crate) struct ScopedBackgroundTask {
    registry: Arc<TaskRegistry>,
    token: Option<String>,
}

impl Drop for ScopedBackgroundTask {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            platform::end(&self.registry, &token);
        }
    }
}

/// Acquire an iOS background assertion before entering a native critical
/// section. Other platforms return an inert guard.
pub(crate) fn scoped(state: &State<'_, BackgroundTaskState>, name: &str) -> ScopedBackgroundTask {
    ScopedBackgroundTask {
        registry: Arc::clone(&state.scoped),
        token: platform::begin(Arc::clone(&state.scoped), name),
    }
}

/// Begin a frontend-owned persistence assertion. Returns `None` when UIKit
/// cannot grant background time, and on non-iOS platforms.
#[tauri::command]
pub fn background_task_begin(state: State<'_, BackgroundTaskState>) -> Option<String> {
    state.begin_frontend("Reflect background persistence")
}

/// End a frontend-owned persistence assertion. Unknown and already-expired
/// tokens are harmless, which makes cleanup safe to retry.
#[tauri::command]
pub fn background_task_end(token: String, state: State<'_, BackgroundTaskState>) {
    state.end_frontend(&token);
}

#[cfg(target_os = "ios")]
mod platform {
    use std::sync::Arc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use objc2_ui_kit::UIBackgroundTaskInvalid;

    use super::{NativeIdentifier, TaskRegistry};

    pub fn begin(registry: Arc<TaskRegistry>, name: &str) -> Option<String> {
        let token = registry.reserve();
        let expiration_registry = Arc::clone(&registry);
        let expiration_token = token.clone();
        let expiration_handler = RcBlock::new(move || {
            end(&expiration_registry, &expiration_token);
        });
        let task_name = NSString::from_str(name);

        // UIKit documents begin/end as `nonisolated`; objc2 conservatively
        // marks the UIApplication class main-thread-only, so message the two
        // thread-safe methods directly. This is also what lets a synchronous
        // SQLite command acquire its assertion *before* taking a DB lock,
        // instead of queueing the begin call behind that same command.
        let application: Retained<AnyObject> =
            unsafe { msg_send![class!(UIApplication), sharedApplication] };
        let identifier: NativeIdentifier = unsafe {
            msg_send![
                &*application,
                beginBackgroundTaskWithName: &*task_name,
                expirationHandler: &*expiration_handler
            ]
        };

        if identifier == unsafe { UIBackgroundTaskInvalid } {
            registry.cancel(&token);
            return None;
        }

        if registry.activate(&token, identifier) {
            Some(token)
        } else {
            // Expiration won the race before `begin…` returned.
            unsafe {
                let _: () = msg_send![&*application, endBackgroundTask: identifier];
            }
            None
        }
    }

    pub fn end(registry: &TaskRegistry, token: &str) {
        let Some(identifier) = registry.take(token) else {
            return;
        };
        let application: Retained<AnyObject> =
            unsafe { msg_send![class!(UIApplication), sharedApplication] };
        unsafe {
            let _: () = msg_send![&*application, endBackgroundTask: identifier];
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod platform {
    use std::sync::Arc;

    use super::TaskRegistry;

    pub fn begin(_registry: Arc<TaskRegistry>, _name: &str) -> Option<String> {
        None
    }

    pub fn end(_registry: &TaskRegistry, _token: &str) {}
}

#[cfg(test)]
mod tests {
    use super::{BackgroundTaskState, TaskRegistry};

    #[test]
    fn normal_completion_consumes_an_active_identifier_once() {
        let registry = TaskRegistry::default();
        let token = registry.reserve();
        assert!(registry.activate(&token, 42));
        assert_eq!(registry.take(&token), Some(42));
        assert_eq!(registry.take(&token), None);
    }

    #[test]
    fn expiration_before_activation_prevents_a_late_identifier_leak() {
        let registry = TaskRegistry::default();
        let token = registry.reserve();
        assert_eq!(registry.take(&token), None);
        assert!(!registry.activate(&token, 42));
    }

    #[test]
    fn cancelled_or_unknown_tokens_are_idempotent() {
        let registry = TaskRegistry::default();
        let token = registry.reserve();
        registry.cancel(&token);
        registry.cancel(&token);
        assert_eq!(registry.take("not-issued"), None);
    }

    #[test]
    fn frontend_tokens_cannot_end_scoped_assertions() {
        let state = BackgroundTaskState::default();
        let frontend_token = state.frontend.reserve();
        let scoped_token = state.scoped.reserve();
        // The counters are deliberately predictable and collide; registry
        // ownership, not token secrecy, is the security boundary.
        assert_eq!(frontend_token, scoped_token);
        assert!(state.frontend.activate(&frontend_token, 11));
        assert!(state.scoped.activate(&scoped_token, 22));

        assert_eq!(state.frontend.take(&frontend_token), Some(11));
        assert_eq!(state.scoped.take(&scoped_token), Some(22));
    }
}
