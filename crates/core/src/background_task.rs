//! iOS finite-length background execution assertions.
//!
//! UIKit may suspend the process shortly after it enters the background. A
//! suspension while SQLite or a file writer owns a lock is fatal (`0xdead10cc`),
//! so native write commands can hold a [`ScopedBackgroundTask`] and the mobile
//! frontend can bracket its whole background persistence flush through the two
//! commands below. Each path has an isolated registry. In the frontend
//! registry, normal completion and UIKit's expiration callback race to remove
//! the token, and only the winner ends the native assertion. In the scoped
//! registry, the expiration callback waits for the guard to drop, so the
//! assertion always ends after the lock is released.

#[cfg(any(target_os = "ios", test))]
use std::collections::HashMap;
use std::sync::Arc;
#[cfg(any(target_os = "ios", test))]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(any(target_os = "ios", test))]
use std::sync::{Condvar, Mutex, MutexGuard};

use crate::Core;

#[cfg(any(target_os = "ios", test))]
type NativeIdentifier = usize;

#[cfg(any(target_os = "ios", test))]
#[derive(Default)]
struct TaskRegistry {
    next_token: AtomicU64,
    tasks: Mutex<HashMap<String, Option<NativeIdentifier>>>,
    removed: Condvar,
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
        let identifier = self.lock().remove(token).flatten();
        self.removed.notify_all();
        identifier
    }

    fn cancel(&self, token: &str) {
        self.lock().remove(token);
        self.removed.notify_all();
    }

    /// Block until the owner of `token` removed it.
    fn wait_until_removed(&self, token: &str) {
        let mut tasks = self.lock();
        while tasks.contains_key(token) {
            tasks = self
                .removed
                .wait(tasks)
                .unwrap_or_else(|poison| poison.into_inner());
        }
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
        platform::begin(Arc::clone(&self.frontend), name, Expiration::End)
    }

    fn end_frontend(&self, token: &str) {
        platform::end(&self.frontend, token);
    }
}

/// What UIKit's expiration callback does with an assertion.
#[derive(Clone, Copy)]
enum Expiration {
    /// End the assertion at once.
    End,
    /// Block the main thread until the owner drops its guard, which ends the
    /// assertion.
    WaitForOwner,
}

/// RAII assertion for native operations that may own a file or SQLite lock.
/// Only `Drop` ends the assertion: UIKit's expiration callback blocks the
/// main thread until then, so the operation releases its lock first on any
/// thread. The operation must not wait for the main thread.
pub struct ScopedBackgroundTask {
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
pub fn scoped(state: &BackgroundTaskState, name: &str) -> ScopedBackgroundTask {
    ScopedBackgroundTask {
        registry: Arc::clone(&state.scoped),
        token: platform::begin(Arc::clone(&state.scoped), name, Expiration::WaitForOwner),
    }
}

impl Core {
    /// Command: begin a frontend-owned persistence assertion. Returns `None`
    /// when UIKit cannot grant background time, and on non-iOS platforms.
    pub fn background_task_begin(&self) -> Option<String> {
        self.background_tasks
            .begin_frontend("Reflect background persistence")
    }

    /// Command: end a frontend-owned persistence assertion. Unknown and
    /// already-expired tokens are harmless, which makes cleanup safe to retry.
    pub fn background_task_end(&self, token: String) {
        self.background_tasks.end_frontend(&token);
    }
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

    use super::{Expiration, NativeIdentifier, TaskRegistry};

    pub fn begin(
        registry: Arc<TaskRegistry>,
        name: &str,
        expiration: Expiration,
    ) -> Option<String> {
        let token = registry.reserve();
        let expiration_registry = Arc::clone(&registry);
        let expiration_token = token.clone();
        let expiration_handler = RcBlock::new(move || match expiration {
            Expiration::End => end(&expiration_registry, &expiration_token),
            Expiration::WaitForOwner => {
                expiration_registry.wait_until_removed(&expiration_token);
            }
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

    use super::{Expiration, TaskRegistry};

    pub fn begin(
        _registry: Arc<TaskRegistry>,
        _name: &str,
        _expiration: Expiration,
    ) -> Option<String> {
        None
    }

    pub fn end(_registry: &TaskRegistry, _token: &str) {}
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{BackgroundTaskState, TaskRegistry};
    use crate::Reply;
    use crate::test_support::core;

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
    fn expiration_of_a_scoped_assertion_waits_for_its_owner() {
        let registry = Arc::new(TaskRegistry::default());
        let token = registry.reserve();
        assert!(registry.activate(&token, 42));
        let (expired, did_expire) = std::sync::mpsc::channel();
        let expiration = std::thread::spawn({
            let registry = Arc::clone(&registry);
            let token = token.clone();
            move || {
                registry.wait_until_removed(&token);
                let _ = expired.send(());
            }
        });

        assert!(
            did_expire
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err()
        );
        assert_eq!(registry.take(&token), Some(42));
        expiration.join().expect("the expiration thread panicked");
        assert!(did_expire.try_recv().is_ok());
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

    #[test]
    fn dispatch_serializes_infallible_results() {
        let core = core();
        core.runtime.block_on(async {
            assert_eq!(
                core.dispatch("background_task_begin", b"{}", b"{}", None)
                    .await
                    .unwrap(),
                Reply::Json("null".into())
            );
            let args = br#"{"token":"background-task-1"}"#;
            assert_eq!(
                core.dispatch("background_task_end", args, b"{}", None)
                    .await
                    .unwrap(),
                Reply::Json("null".into())
            );
        });
    }
}
