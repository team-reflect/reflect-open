//! Test-only fault injection for the git primitives.
//!
//! The sync safety tests (`docs/git-backup-safety.md`) need to stop a pull
//! at a precise point: between the branch move and the checkout, or after
//! libgit2 entered merge state but before the merge commit. A real process
//! dies anywhere; these hooks make "anywhere" reproducible. The call sites
//! in `merge.rs` are `#[cfg(test)]`, so release builds carry nothing.
//!
//! Faults are thread-local and one-shot: a test arms a point on the thread
//! that will run the git command, and the first `trip` of that point
//! consumes it. Parallel tests never see each other's faults.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{AppError, AppResult};

/// Where a git command can be interrupted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum FaultPoint {
    /// Fast-forward: before the branch ref is moved.
    BeforeFastForwardRefMove,
    /// Fast-forward: before the working tree is written.
    BeforeFastForwardCheckout,
    /// Merge: after libgit2 entered merge state, before the merge commit.
    AfterMergeBeforeCommit,
}

/// What happens when an armed point is reached.
#[derive(Clone)]
pub(super) enum Fault {
    /// Return an error from the command, as a failed syscall would.
    Fail,
    /// Unwind, standing in for the process being killed mid-command.
    Panic,
    /// Run a closure (block on a channel to let another thread race in).
    /// Faults run on the thread that armed them, so no `Send`/`Sync` bound.
    Hook(Arc<dyn Fn()>),
}

impl Fault {
    pub(super) fn hook(f: impl Fn() + 'static) -> Fault {
        Fault::Hook(Arc::new(f))
    }
}

thread_local! {
    static ARMED: RefCell<HashMap<FaultPoint, Fault>> = RefCell::new(HashMap::new());
}

/// Arm `fault` at `point` for the current thread (one-shot).
pub(super) fn arm(point: FaultPoint, fault: Fault) {
    ARMED.with(|armed| {
        armed.borrow_mut().insert(point, fault);
    });
}

/// Called by the git primitives at each [`FaultPoint`]. A no-op unless the
/// current thread armed that point.
pub(super) fn trip(point: FaultPoint) -> AppResult<()> {
    let fault = ARMED.with(|armed| armed.borrow_mut().remove(&point));
    match fault {
        None => Ok(()),
        Some(Fault::Fail) => Err(AppError::io(format!("injected failure at {point:?}"))),
        Some(Fault::Panic) => panic!("injected crash at {point:?}"),
        Some(Fault::Hook(hook)) => {
            hook();
            Ok(())
        }
    }
}
