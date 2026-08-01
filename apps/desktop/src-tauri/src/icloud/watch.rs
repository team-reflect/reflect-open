//! The iCloud change watcher: an `NSMetadataQuery` over the graph (Plan 21
//! Phase 2).
//!
//! Two jobs, per platform:
//!
//! - **iOS**: the *sole* external-change source. There is no file watcher on
//!   mobile — this query's snapshot diffs become the standard `index:changed`
//!   batches the indexer and open sessions already consume.
//! - **Both Apple platforms**: the conflict signal. A conflict version
//!   appearing does not necessarily touch the working file, so the desktop
//!   `notify` watcher alone would sit silent; the query's
//!   `HasUnresolvedConflicts` flag is what triggers a sweep promptly.
//!
//! Threading follows the platform contract: the query starts/stops on the
//! main thread (kept there via `MainThreadBound`), results are delivered on a
//! private `NSOperationQueue`, and the notification handler diffs a plain
//! Rust snapshot — no Objective-C state crosses threads.
//!
//! Items whose download status is not "current" are tracked but never
//! reported as upserts (their bytes aren't local yet — the indexer would read
//! a stub) and never as removes (eviction is not deletion; the item is still
//! listed). When iCloud finishes a download, the next update round reports
//! the real upsert.
//!
//! Download nudges are **changed-only**: a placeholder is requested when its
//! content is something this device lacks (a new arrival, or a remote edit
//! reaching an evicted item), never because the OS evicted content we already
//! indexed — that would fight Optimize Storage indefinitely. Open-path
//! catch-up (placeholders the *index* lacks) is the reconcile's targeted
//! `icloud_request_downloads`, not this watch.

use crate::error::AppResult;

/// Command: watch the graph at `root` for iCloud changes. `emit_file_changes`
/// turns snapshot diffs into `index:changed` events — pass `true` on mobile
/// (no watcher there), `false` on desktop (the `notify` watcher already
/// reports file events; double delivery is harmless but wasteful). Conflict
/// paths always emit as `icloud:conflicts`.
#[tauri::command]
pub async fn icloud_watch_start(
    root: String,
    emit_file_changes: bool,
    app: tauri::AppHandle,
) -> AppResult<()> {
    // Whether the query's scope actually covers this root — it lists the
    // app's own ubiquity container only, so for any other iCloud path (a
    // desktop graph in the user's general iCloud Drive) the gather produces
    // an empty view that must read as "unknown", never "no conflicts".
    // Resolved off the main thread: the container API can block on first
    // use. Best-effort — a failed probe degrades to "not authoritative"
    // (sweeps go full, the safe direction) rather than failing the start:
    // on mobile this watch is the sole external-change source, and losing
    // it over a coverage probe would be the far worse trade.
    let authoritative = {
        let root = root.clone();
        crate::blocking::run_blocking(move || Ok(query_covers_root(&root)))
            .await
            .unwrap_or(false)
    };
    platform::start(app, root, emit_file_changes, authoritative)
}

/// See [`icloud_watch_start`]: `root` lives inside the app's own ubiquity
/// container. The lookup is a pure path resolve — watching a graph kept
/// elsewhere in iCloud Drive must not create the container as a side effect.
fn query_covers_root(root: &str) -> bool {
    match super::storage::ubiquity_documents_path() {
        Some(documents) => root_within(std::path::Path::new(root), &documents),
        None => false,
    }
}

/// Canonicalized prefix check — iOS containers sit behind the `/var` →
/// `/private/var` symlink, and a lexical compare would miss. A path that
/// fails to canonicalize (not on disk) compares as spelled.
fn root_within(root: &std::path::Path, documents: &std::path::Path) -> bool {
    fn canonical(path: &std::path::Path) -> std::path::PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }
    canonical(root).starts_with(canonical(documents))
}

#[cfg(test)]
mod coverage_tests {
    use super::root_within;

    #[test]
    fn resolves_symlinked_spellings_before_comparing() {
        let dir = tempfile::tempdir().unwrap();
        let documents = dir.path().join("container/Documents");
        std::fs::create_dir_all(documents.join("Graph")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("container"), dir.path().join("alias")).unwrap();

        assert!(root_within(&documents.join("Graph"), &documents));
        // The same graph reached through a symlinked spelling still matches —
        // the iOS `/var` → `/private/var` shape.
        assert!(root_within(
            &dir.path().join("alias/Documents/Graph"),
            &documents
        ));
        // A sibling outside the container never does.
        let elsewhere = dir.path().join("CloudDocs/Graph");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert!(!root_within(&elsewhere, &documents));
    }
}

/// Command: stop the active watch (graph switch or shutdown). Idempotent.
#[tauri::command]
pub fn icloud_watch_stop(app: tauri::AppHandle) -> AppResult<()> {
    platform::stop(app)
}

/// The paths the live metadata query currently flags as carrying unresolved
/// conflict versions — the scoped conflict sweep's candidate set. `None`
/// whenever the query cannot answer completely (no watch installed, or the
/// gather round hasn't seeded the view yet); callers must treat `None` as
/// "check everything". The set may run momentarily stale in the harmless
/// direction only: a just-resolved path lingers until its update round lands
/// (an extra no-op check), while a new conflict is always in the set before
/// the `icloud:conflicts` signal that triggers a sweep, because both come
/// from the same notification round.
pub(crate) fn conflicted_paths() -> Option<std::collections::HashSet<String>> {
    platform::conflicted_paths()
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod platform {
    use std::collections::{HashMap, HashSet};
    use std::ptr::NonNull;
    use std::sync::{LazyLock, Mutex};

    use block2::RcBlock;
    use dispatch2::MainThreadBound;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_foundation::{
        NSArray, NSCopying, NSDate, NSMetadataItem, NSMetadataItemFSContentChangeDateKey,
        NSMetadataItemPathKey, NSMetadataQuery, NSMetadataQueryDidFinishGatheringNotification,
        NSMetadataQueryDidUpdateNotification, NSMetadataQueryUbiquitousDocumentsScope,
        NSMetadataQueryUpdateAddedItemsKey, NSMetadataQueryUpdateChangedItemsKey,
        NSMetadataQueryUpdateRemovedItemsKey, NSMetadataUbiquitousItemDownloadingStatusCurrent,
        NSMetadataUbiquitousItemDownloadingStatusKey,
        NSMetadataUbiquitousItemHasUnresolvedConflictsKey, NSNotification, NSNotificationCenter,
        NSNumber, NSOperationQueue, NSPredicate, NSString,
    };
    use serde::Serialize;
    use tauri::{Emitter, Manager};

    use crate::error::{AppError, AppResult};

    /// How long the query buckets live updates before delivering one
    /// `DidUpdate` notification. During an initial mass download thousands of
    /// files flip to current one by one; without an explicit interval each
    /// flip can arrive as its own notification, and every notification costs
    /// a JS `index:changed` round downstream. Two seconds keeps "a Mac edit
    /// appears in seconds" while collapsing a download burst into a handful
    /// of batches.
    const UPDATE_BATCHING_INTERVAL_S: f64 = 2.0;

    /// The live query plus everything that must stay alive (and on the main
    /// thread) with it.
    struct Watch {
        query: Retained<NSMetadataQuery>,
        /// Never read — held so the delivery queue outlives the query.
        _queue: Retained<NSOperationQueue>,
        tokens: Vec<Retained<AnyObject>>,
    }

    /// The active watch, pinned to the main thread. `MainThreadBound` keeps
    /// the non-`Send` Objective-C handles sound inside a global.
    static ACTIVE: Mutex<Option<MainThreadBound<Watch>>> = Mutex::new(None);

    /// One tracked item's last-known sync state.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum TrackedState {
        /// Bytes are local, at this content-change mtime (epoch ms).
        Local(u64),
        /// Listed but not downloaded (a placeholder, or an eviction). The
        /// provider's content-change date rides along — it is cloud
        /// metadata, present without local bytes — so a *remote edit*
        /// reaching an evicted item is distinguishable from the eviction
        /// itself.
        Evicted(Option<u64>),
    }

    /// Last reported state per graph-relative path. Plain Rust — safe to
    /// touch from the delivery queue.
    static SNAPSHOT: LazyLock<Mutex<HashMap<String, TrackedState>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// The scoped sweep's candidate view: the paths the provider currently
    /// flags as carrying unresolved conflict versions, maintained by the
    /// same rounds that emit `icloud:conflicts`. Everything that decides
    /// whether the view may be *trusted* lives in the same struct, under one
    /// lock, so a reader can never observe a torn combination (readiness
    /// from one watch, paths from another):
    ///
    /// - `epoch` pins the view to one install; rounds carry the epoch their
    ///   watch was installed with, and a stale round — an old query's
    ///   in-flight gather completing after teardown or after a newer graph's
    ///   install — folds into nothing.
    /// - `authoritative` records whether the query's scope actually covers
    ///   the watched root (the app's own ubiquity container). For any other
    ///   iCloud path the query gathers an *empty* view that must read as
    ///   "unknown", never "no conflicts".
    /// - `gathered` flips only when a full listing of this epoch lands;
    ///   before that the set is empty for the wrong reason.
    #[derive(Default)]
    struct ConflictView {
        epoch: u64,
        authoritative: bool,
        gathered: bool,
        paths: HashSet<String>,
    }

    /// The live [`ConflictView`]. Install epochs start at 1, so the default
    /// view (epoch 0) can never accept a round.
    static CONFLICT_VIEW: LazyLock<Mutex<ConflictView>> =
        LazyLock::new(|| Mutex::new(ConflictView::default()));

    /// Content-change date last download-requested, per graph-relative path.
    /// The OS treats repeat requests as no-ops, but *issuing* them is not
    /// free: during an initial sync every update round used to re-request
    /// every still-pending placeholder — O(N) `NSFileManager` calls per
    /// round, O(N²) across a large download. Each (path, date) is requested
    /// once; completion (or removal from the listing) clears the entry. A
    /// download that silently stalls is retried by the resume-path
    /// `icloud_download_pending` walk, which requests unconditionally.
    static NUDGED: LazyLock<Mutex<HashMap<String, Option<u64>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// The watcher's change event, matching `watcher::FileChange`.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FileChange {
        path: String,
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        modified_ms: Option<u64>,
    }

    /// Lifecycle epoch: every `start`/`stop` bumps it, and a queued install
    /// only proceeds when its epoch is still current. Commands run off the
    /// main thread while installs run *on* it, so without this a second
    /// `start` could slip in before the first's install executed — `stop`
    /// would find `ACTIVE` still empty, and the first query would leak,
    /// its observers emitting events for the wrong graph root forever
    /// (dropping observer tokens does not deregister them).
    static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    pub fn start(
        app: tauri::AppHandle,
        root: String,
        emit_file_changes: bool,
        authoritative: bool,
    ) -> AppResult<()> {
        use std::sync::atomic::Ordering;
        let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
        let handle = app.clone();
        app.run_on_main_thread(move || {
            install(handle, root, emit_file_changes, authoritative, epoch)
        })
        .map_err(|err| AppError::io(format!("failed to reach the main thread: {err}")))
    }

    pub fn stop(app: tauri::AppHandle) -> AppResult<()> {
        use std::sync::atomic::Ordering;
        // Invalidate any queued-but-not-yet-run install…
        EPOCH.fetch_add(1, Ordering::SeqCst);
        // …and tear down whatever is actually live, on the main thread —
        // where installs also run, so the two can never interleave.
        app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new().expect("run_on_main_thread is the main thread");
            teardown_active(mtm);
        })
        .map_err(|err| AppError::io(format!("failed to reach the main thread: {err}")))
    }

    /// Stop and deregister the live watch, if any. Main thread only — every
    /// caller is a main-thread closure, which is what serializes teardown
    /// against installs.
    fn teardown_active(mtm: MainThreadMarker) {
        // A stopped watch must answer "unknown", never "no conflicts".
        *CONFLICT_VIEW.lock().expect("conflict view lock") = ConflictView::default();
        let Some(bound) = ACTIVE.lock().expect("watch lock").take() else {
            return;
        };
        let watch = bound.into_inner(mtm);
        watch.query.stopQuery();
        let center = NSNotificationCenter::defaultCenter();
        for token in &watch.tokens {
            unsafe {
                let _: () = msg_send![&center, removeObserver: &**token];
            }
        }
    }

    /// The root plus its canonicalized twin, both slash-terminated. Spotlight
    /// reports real paths — on iOS the container lives behind the `/var` →
    /// `/private/var` symlink, so a predicate (or a prefix strip) built from
    /// the un-resolved root alone would match nothing and the watch would sit
    /// silent. The trailing slash makes both the predicate and the strip a
    /// real path boundary: `…/Notes` must never claim `…/Notes-old/…`.
    fn root_variants(root: &str) -> Vec<String> {
        let with_slash = |value: &str| format!("{}/", value.trim_end_matches('/'));
        let mut variants = vec![with_slash(root)];
        if let Ok(canonical) = std::fs::canonicalize(root) {
            let canonical = with_slash(&canonical.to_string_lossy());
            if !variants.contains(&canonical) {
                variants.push(canonical);
            }
        }
        variants
    }

    /// Build, wire, and start the query. Main thread only. Tears down any
    /// live watch first (installs and stops all run here, serially), and
    /// aborts when a later `start`/`stop` has superseded this one's epoch —
    /// so rapid graph switches can never leave two queries running or
    /// install a watch after its graph closed.
    fn install(
        app: tauri::AppHandle,
        root: String,
        emit_file_changes: bool,
        authoritative: bool,
        epoch: u64,
    ) {
        use std::sync::atomic::Ordering;
        let mtm = MainThreadMarker::new().expect("run_on_main_thread is the main thread");
        teardown_active(mtm);
        if EPOCH.load(Ordering::SeqCst) != epoch {
            return; // superseded while queued — a newer install/stop owns the lifecycle
        }
        SNAPSHOT.lock().expect("snapshot lock").clear();
        NUDGED.lock().expect("nudge lock").clear();
        *CONFLICT_VIEW.lock().expect("conflict view lock") = ConflictView {
            epoch,
            authoritative,
            gathered: false,
            paths: HashSet::new(),
        };
        let query = NSMetadataQuery::new();
        query.setNotificationBatchingInterval(UPDATE_BATCHING_INTERVAL_S);

        let scope: Retained<NSString> = unsafe { NSMetadataQueryUbiquitousDocumentsScope.copy() };
        let scopes = NSArray::from_retained_slice(&[scope]);
        // setSearchScopes/argumentArray take untyped NSArrays the bindings
        // can't coerce typed arrays into — message directly.
        unsafe {
            let _: () = msg_send![&query, setSearchScopes: &*scopes];
        }

        let roots = root_variants(&root);
        let path_key: Retained<NSString> = unsafe { NSMetadataItemPathKey.copy() };
        let format = NSString::from_str(
            &(0..roots.len())
                .map(|_| "(%K BEGINSWITH %@)")
                .collect::<Vec<_>>()
                .join(" OR "),
        );
        let mut arg_list: Vec<Retained<NSString>> = Vec::new();
        for variant in &roots {
            arg_list.push(path_key.copy());
            arg_list.push(NSString::from_str(variant));
        }
        let args = NSArray::from_retained_slice(&arg_list);
        let predicate: Retained<NSPredicate> = unsafe {
            msg_send![
                objc2::class!(NSPredicate),
                predicateWithFormat: &*format,
                argumentArray: &*args
            ]
        };
        query.setPredicate(Some(&predicate));

        let queue = NSOperationQueue::new();
        // Must stay serial: CloudDocs (BRQuery) schedules its own internal,
        // unsynchronized gatherer work on this queue — not just notification
        // delivery. On the default concurrent queue the initial gather and
        // update batches classify items in parallel and corrupt BRQuery's
        // result index sets, aborting with an uncaught NSRangeException
        // (crash: NSMutableIndexSet addIndexesInRange in
        // _handleReplacedItemsNotifications, ~10s after launch).
        queue.setMaxConcurrentOperationCount(1);
        unsafe { query.setOperationQueue(Some(&queue)) };

        let handler_roots = roots.clone();
        let emit_app = app.clone();
        let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
            handle_notification(&app, &handler_roots, emit_file_changes, epoch, notification);
        });
        let center = NSNotificationCenter::defaultCenter();
        let query_object: &AnyObject = &query;
        let mut tokens = Vec::new();
        for name in [
            unsafe { NSMetadataQueryDidFinishGatheringNotification },
            unsafe { NSMetadataQueryDidUpdateNotification },
        ] {
            let token: Retained<AnyObject> = unsafe {
                msg_send![
                    &center,
                    addObserverForName: name,
                    object: query_object,
                    queue: &*queue,
                    usingBlock: &*block
                ]
            };
            tokens.push(token);
        }

        if !query.startQuery() {
            // Per Apple docs this means "already running" or "no predicate" —
            // neither can happen for this fresh, predicated query, but if it
            // ever does, an installed-but-dead watch would silently eat the
            // stop/start lifecycle. Tear the observers down and leave ACTIVE
            // empty instead; the controller's resume-triggered sweeps keep
            // conflict handling alive without the query. (The install runs
            // fire-and-forget on the main thread, so the command has already
            // returned — an error can't reach the caller from here.)
            tracing::warn!("iCloud metadata query failed to start; falling back to sweep triggers");
            let center = NSNotificationCenter::defaultCenter();
            for token in &tokens {
                unsafe {
                    let _: () = msg_send![&center, removeObserver: &**token];
                }
            }
            // The command returned long ago (this closure is fire-and-forget
            // on the main thread), so surface the failure as an event: the
            // controller logs it loudly and runs an immediate fallback sweep
            // — on iOS the query is the sole live change source, and a
            // silently dead watch would otherwise read as "no changes".
            let _ = emit_app.emit("icloud:watch-failed", ());
            return;
        }
        *ACTIVE.lock().expect("watch lock") = Some(MainThreadBound::new(
            Watch {
                query,
                _queue: queue,
                tokens,
            },
            mtm,
        ));
    }

    /// One tracked item's state, extracted from its `NSMetadataItem`.
    struct ItemState {
        /// Graph-relative note path.
        rel: String,
        /// Absolute path, for download requests.
        abs: String,
        /// True when the content is local ("current"); false for placeholders
        /// and partial downloads.
        downloaded: bool,
        /// Content-change date (epoch ms), when the item reports one.
        mtime: Option<u64>,
        /// The provider's unresolved-conflict flag.
        conflict: bool,
    }

    impl ItemState {
        /// The snapshot value for this item.
        fn snapshot_state(&self) -> TrackedState {
            if self.downloaded {
                TrackedState::Local(self.mtime.unwrap_or(0))
            } else {
                TrackedState::Evicted(self.mtime)
            }
        }
    }

    /// Extract the tracked state from one metadata item; `None` for items
    /// outside the graph's note directories.
    fn item_state(item: &NSMetadataItem, roots: &[String]) -> Option<ItemState> {
        let abs = attr_string(item, unsafe { NSMetadataItemPathKey })?;
        let rel = tracked_note_relpath(&abs, roots)?;
        let downloaded = attr_string(item, unsafe {
            NSMetadataUbiquitousItemDownloadingStatusKey
        })
        .is_some_and(|status| {
            status == unsafe { NSMetadataUbiquitousItemDownloadingStatusCurrent }.to_string()
        });
        let mtime = attr_date_ms(item, unsafe { NSMetadataItemFSContentChangeDateKey });
        let conflict = attr_bool(item, unsafe {
            NSMetadataUbiquitousItemHasUnresolvedConflictsKey
        });
        Some(ItemState {
            rel,
            abs,
            downloaded,
            mtime,
            conflict,
        })
    }

    /// What one notification round produced: the file events to emit and the
    /// paths the provider reports as conflicted.
    struct Round {
        changes: Vec<FileChange>,
        conflicts: Vec<String>,
    }

    /// Pure half of the nudge bookkeeping: the placeholders this round should
    /// request downloads for. Only content the device *provably lacks* is
    /// nudged — an item new to the snapshot (e.g. a note created on another
    /// device), or one whose content-change date moved to a *known different*
    /// date (a remote edit reaching an evicted item). Everything ambiguous
    /// stays silent: an eviction of already-seen content, and any report
    /// without a usable date on either side — re-downloading whatever the OS
    /// just evicted turns Optimize Storage into a tug-of-war that keeps
    /// `fileproviderd` pinned for as long as the app runs, and a genuinely
    /// missed remote edit is caught by the reconcile's mtime comparison on
    /// the next pass. Gather rounds never nudge (see
    /// [`handle_notification`]) — open-path catch-up belongs to the
    /// reconcile's targeted `icloud_request_downloads`, which consults the
    /// *index* rather than this watch's session-local snapshot.
    fn plan_nudges(
        nudged: &mut HashMap<String, Option<u64>>,
        snapshot: &HashMap<String, TrackedState>,
        items: &[ItemState],
    ) -> Vec<String> {
        let mut request: Vec<String> = Vec::new();
        for item in items {
            if item.downloaded {
                nudged.remove(&item.rel);
                continue;
            }
            let missing = match snapshot.get(&item.rel) {
                None => true, // an arrival: content this device has never had
                Some(TrackedState::Local(mtime)) => item.mtime.is_some_and(|date| date != *mtime),
                Some(TrackedState::Evicted(previous)) => item
                    .mtime
                    .is_some_and(|date| previous.is_some_and(|prev| date != prev)),
            };
            if !missing || nudged.get(&item.rel) == Some(&item.mtime) {
                continue;
            }
            nudged.insert(item.rel.clone(), item.mtime);
            request.push(item.abs.clone());
        }
        request
    }

    /// Request downloads for the placeholders [`plan_nudges`] marked. Must
    /// run *before* the round's delta folds into [`SNAPSHOT`] — the plan
    /// compares against the previous states.
    fn nudge_pending(items: &[ItemState]) {
        let request = {
            let snapshot = SNAPSHOT.lock().expect("snapshot lock");
            let mut nudged = NUDGED.lock().expect("nudge lock");
            plan_nudges(&mut nudged, &snapshot, items)
        };
        for abs in request {
            crate::icloud::storage::request_download(std::path::Path::new(&abs));
        }
    }

    /// The items the provider flags as carrying unresolved conflict versions.
    fn conflicted_rels(items: &[ItemState]) -> Vec<String> {
        items
            .iter()
            .filter(|item| item.conflict)
            .map(|item| item.rel.clone())
            .collect()
    }

    /// Fold one round's items into the conflicted-path set: a reported item
    /// enters or leaves by its flag, a removed item leaves. Pure, so the set
    /// semantics are unit-testable next to [`apply_update_delta`]'s.
    fn apply_conflict_delta(
        conflicted: &mut HashSet<String>,
        upserted: &[ItemState],
        removed: &[String],
    ) {
        for item in upserted {
            if item.conflict {
                conflicted.insert(item.rel.clone());
            } else {
                conflicted.remove(&item.rel);
            }
        }
        for rel in removed {
            conflicted.remove(rel);
        }
    }

    /// The scoped sweep's candidate set — see the outer
    /// [`super::conflicted_paths`] for the contract. One lock read: the
    /// trust conditions and the paths come from the same view, and the
    /// epoch check also covers "the watch was stopped but its main-thread
    /// teardown hasn't run yet" (stop bumps [`EPOCH`] synchronously).
    pub(crate) fn conflicted_paths() -> Option<HashSet<String>> {
        use std::sync::atomic::Ordering;
        let view = CONFLICT_VIEW.lock().expect("conflict view lock");
        (view.authoritative && view.gathered && view.epoch == EPOCH.load(Ordering::SeqCst))
            .then(|| view.paths.clone())
    }

    /// Fold one round's conflict information into the live view, iff the
    /// round belongs to the view's install epoch — a stale round from a
    /// torn-down watch (an old query's gather completing late) must never
    /// seed or poison a newer watch's view. A full listing (`rebuild`)
    /// replaces the set wholesale and is the only round shape that may
    /// declare the view gathered.
    fn fold_conflicts_into_view(
        view: &mut ConflictView,
        epoch: u64,
        upserted: &[ItemState],
        removed: &[String],
        rebuild: bool,
    ) {
        if view.epoch != epoch {
            return;
        }
        if rebuild {
            view.paths.clear();
        }
        apply_conflict_delta(&mut view.paths, upserted, removed);
        if rebuild {
            view.gathered = true;
        }
    }

    /// One gathering/update round. Updates apply the notification's own
    /// added/changed/removed delta — O(changed items); a full results
    /// enumeration here would be O(all items) per round, O(n²) across an
    /// initial mass download. The gather round (and an update without a
    /// usable delta) still snapshots the full listing.
    fn handle_notification(
        app: &tauri::AppHandle,
        roots: &[String],
        emit_file_changes: bool,
        epoch: u64,
        notification: NonNull<NSNotification>,
    ) {
        let notification = unsafe { notification.as_ref() };
        let Some(object) = notification.object() else {
            return;
        };
        let Ok(query) = object.downcast::<NSMetadataQuery>() else {
            return;
        };

        let is_update = &*notification.name() == unsafe { NSMetadataQueryDidUpdateNotification };
        let round = if is_update {
            match update_delta(notification, roots) {
                Some((upserted, removed)) => update_round(&upserted, &removed, epoch),
                None => full_round(&query, roots, true, epoch),
            }
        } else {
            // The gather round: this watch just started, with an empty
            // snapshot — every placeholder would compare as "new". Nudging
            // here used to re-request every evicted file in the graph on
            // every app open, an unpaced download storm that pinned
            // fileproviderd. The reconcile's targeted downloads own
            // open-path catch-up; this round only seeds the snapshot.
            full_round(&query, roots, false, epoch)
        };

        if !round.changes.is_empty() {
            // The listing cache must not outlive a change this round observed
            // (a download materialized, a Mac-side edit landed). Try every
            // root variant: invalidation is root-checked, so the one matching
            // the open graph wins and the others are no-ops.
            let state = app.state::<crate::fs::GraphState>();
            for root in roots {
                let root = std::path::Path::new(root.trim_end_matches('/'));
                crate::fs::invalidate_file_catalog(&state, root);
            }
            if emit_file_changes && is_update {
                let _ = app.emit("index:changed", round.changes);
            }
        }
        if emit_file_changes && !is_update {
            // The gather round diffs against an empty snapshot, so its
            // "changes" are every downloaded note in the graph — not news,
            // just the watch coming up. Emitting them sent an O(graph)
            // payload through every index:changed listener on each open.
            // The open-path reconcile already covers on-disk state; one
            // coarse reconcile signal (coalesced by the frontend) closes the
            // window between its listing and the gather completing. Emitted
            // regardless of the round's diff: what raced in may be invisible
            // to it — a deletion leaves the empty-snapshot diff empty, and
            // placeholders never appear as changes at all — so an empty
            // gather proves nothing about that window.
            let _ = app.emit(crate::watcher::RECONCILE_EVENT, ());
        }
        if !round.conflicts.is_empty() {
            let mut conflicts = round.conflicts;
            conflicts.sort();
            let _ = app.emit("icloud:conflicts", conflicts);
        }
    }

    /// Apply one update notification's delta: nudge placeholders whose
    /// content this device lacks, fold the delta into the snapshot, and drop
    /// nudge marks for removed items.
    fn update_round(upserted: &[ItemState], removed: &[String], epoch: u64) -> Round {
        nudge_pending(upserted);
        let changes = {
            let mut snapshot = SNAPSHOT.lock().expect("snapshot lock");
            apply_update_delta(&mut snapshot, upserted, removed)
        };
        {
            let mut nudged = NUDGED.lock().expect("nudge lock");
            for rel in removed {
                nudged.remove(rel);
            }
        }
        {
            let mut view = CONFLICT_VIEW.lock().expect("conflict view lock");
            fold_conflicts_into_view(&mut view, epoch, upserted, removed, false);
        }
        Round {
            changes,
            conflicts: conflicted_rels(upserted),
        }
    }

    /// Snapshot the query's full results listing — the gather round (`nudge:
    /// false`), and the fallback for an update notification without a usable
    /// delta (`nudge: true`; the gather already seeded the snapshot, so the
    /// changed-only comparison works). Expressed through
    /// [`apply_update_delta`] (every listed item as an upsert, every
    /// snapshot row missing from the listing as a remove) so the full and
    /// incremental paths share one set of diff rules and can never drift.
    fn full_round(query: &NSMetadataQuery, roots: &[String], nudge: bool, epoch: u64) -> Round {
        query.disableUpdates();
        let results = query.results();
        let mut items: Vec<ItemState> = Vec::new();
        for item in results.iter() {
            let Ok(item) = item.downcast::<NSMetadataItem>() else {
                continue;
            };
            if let Some(state) = item_state(&item, roots) {
                items.push(state);
            }
        }
        query.enableUpdates();

        if nudge {
            nudge_pending(&items);
        }
        let listed: HashSet<&str> = items.iter().map(|item| item.rel.as_str()).collect();
        {
            // Placeholders that vanished from the listing can't complete —
            // drop their nudge marks along with the snapshot rows.
            let mut nudged = NUDGED.lock().expect("nudge lock");
            nudged.retain(|rel, _| listed.contains(rel.as_str()));
        }
        let changes = {
            let mut snapshot = SNAPSHOT.lock().expect("snapshot lock");
            let removed: Vec<String> = snapshot
                .keys()
                .filter(|rel| !listed.contains(rel.as_str()))
                .cloned()
                .collect();
            apply_update_delta(&mut snapshot, &items, &removed)
        };
        {
            // A full listing is authoritative — rebuild the set wholesale;
            // only a full listing may declare the view complete, and only
            // for the epoch it belongs to.
            let mut view = CONFLICT_VIEW.lock().expect("conflict view lock");
            fold_conflicts_into_view(&mut view, epoch, &items, &[], true);
        }
        Round {
            changes,
            conflicts: conflicted_rels(&items),
        }
    }

    /// The added/changed/removed items an update notification carries in its
    /// `userInfo`. `None` when the dictionary is missing entirely (fall back
    /// to a full round); empty arrays are a real "nothing tracked changed".
    fn update_delta(
        notification: &NSNotification,
        roots: &[String],
    ) -> Option<(Vec<ItemState>, Vec<String>)> {
        let info = notification.userInfo()?;
        let items_for = |key: &NSString| -> Vec<Retained<NSMetadataItem>> {
            let value: Option<Retained<AnyObject>> =
                unsafe { msg_send![&*info, objectForKey: key] };
            let Some(value) = value else {
                return Vec::new();
            };
            let Ok(array) = value.downcast::<NSArray>() else {
                return Vec::new();
            };
            array
                .iter()
                .filter_map(|item| item.downcast::<NSMetadataItem>().ok())
                .collect()
        };
        let mut upserted: Vec<ItemState> = Vec::new();
        for key in [unsafe { NSMetadataQueryUpdateAddedItemsKey }, unsafe {
            NSMetadataQueryUpdateChangedItemsKey
        }] {
            for item in items_for(key) {
                if let Some(state) = item_state(&item, roots) {
                    upserted.push(state);
                }
            }
        }
        let removed: Vec<String> = items_for(unsafe { NSMetadataQueryUpdateRemovedItemsKey })
            .iter()
            .filter_map(|item| {
                let path = attr_string(item, unsafe { NSMetadataItemPathKey })?;
                tracked_note_relpath(&path, roots)
            })
            .collect();
        Some((upserted, removed))
    }

    /// Apply a delta to the snapshot, returning the events to emit — the one
    /// home of the diff rules (both the incremental update path and the
    /// full-listing round route through it, kept free of Objective-C so it is
    /// unit testable): upserts only for content that is **local**
    /// (downloaded) and new or mtime-changed; removes only for paths gone
    /// from the listing entirely; and an eviction (downloaded → placeholder)
    /// is silent in both directions — eviction is not deletion, and its bytes
    /// aren't local to upsert — until iCloud downloads the item again.
    fn apply_update_delta(
        snapshot: &mut HashMap<String, TrackedState>,
        upserted: &[ItemState],
        removed: &[String],
    ) -> Vec<FileChange> {
        let mut changes: Vec<FileChange> = Vec::new();
        for item in upserted {
            let state = item.snapshot_state();
            let previous = snapshot.insert(item.rel.clone(), state);
            let TrackedState::Local(mtime) = state else {
                continue; // placeholder (or eviction): bytes aren't local
            };
            if previous != Some(TrackedState::Local(mtime)) {
                changes.push(FileChange {
                    path: item.rel.clone(),
                    kind: "upsert".to_string(),
                    modified_ms: Some(mtime),
                });
            }
        }
        for rel in removed {
            if snapshot.remove(rel).is_some() {
                changes.push(FileChange {
                    path: rel.clone(),
                    kind: "remove".to_string(),
                    modified_ms: None,
                });
            }
        }
        changes
    }

    /// The watcher's note-tracking rule, over absolute metadata paths: an
    /// eligible Markdown note anywhere visible (the shared
    /// `reflect-graph-paths` policy), graph-relative. Tries every root
    /// variant — Spotlight may report either side of the
    /// `/var` ↔ `/private/var` symlink. Variants are slash-terminated
    /// ([`root_variants`]), so the strip is a path boundary, not a string
    /// prefix — a sibling `…/Notes-old/` can never masquerade as the graph.
    fn tracked_note_relpath(path: &str, roots: &[String]) -> Option<String> {
        let rel = roots
            .iter()
            .find_map(|root| path.strip_prefix(root.as_str()))?;
        reflect_graph_paths::is_note(rel).then(|| rel.to_string())
    }

    /// A metadata attribute as a string; `None` when absent or another type.
    fn attr_string(item: &NSMetadataItem, key: &NSString) -> Option<String> {
        let value = item.valueForAttribute(key)?;
        value.downcast::<NSString>().ok().map(|s| s.to_string())
    }

    /// A boolean metadata attribute; absent or non-numeric reads as `false`.
    fn attr_bool(item: &NSMetadataItem, key: &NSString) -> bool {
        item.valueForAttribute(key)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|number| number.boolValue())
            .unwrap_or(false)
    }

    /// A date metadata attribute as epoch ms, clamped at 0 for pre-epoch dates.
    fn attr_date_ms(item: &NSMetadataItem, key: &NSString) -> Option<u64> {
        let date = item.valueForAttribute(key)?.downcast::<NSDate>().ok()?;
        let seconds = date.timeIntervalSince1970();
        if seconds <= 0.0 {
            return Some(0);
        }
        Some((seconds * 1000.0) as u64)
    }

    #[cfg(test)]
    mod tests {
        use super::{
            apply_conflict_delta, apply_update_delta, fold_conflicts_into_view, plan_nudges,
            root_variants, tracked_note_relpath, ConflictView, ItemState, TrackedState,
        };
        use std::collections::{HashMap, HashSet};

        fn state(entries: &[(&str, TrackedState)]) -> HashMap<String, TrackedState> {
            entries
                .iter()
                .map(|(rel, tracked)| (rel.to_string(), *tracked))
                .collect()
        }

        fn local(mtime: u64) -> TrackedState {
            TrackedState::Local(mtime)
        }

        fn evicted(mtime: Option<u64>) -> TrackedState {
            TrackedState::Evicted(mtime)
        }

        fn item(rel: &str, downloaded: bool, mtime: Option<u64>) -> ItemState {
            ItemState {
                rel: rel.to_string(),
                abs: format!("/container/Notes/{rel}"),
                downloaded,
                mtime,
                conflict: false,
            }
        }

        fn shapes(changes: &[super::FileChange]) -> Vec<(String, String, Option<u64>)> {
            let mut shapes: Vec<_> = changes
                .iter()
                .map(|change| (change.path.clone(), change.kind.clone(), change.modified_ms))
                .collect();
            shapes.sort();
            shapes
        }

        fn conflicted_item(rel: &str) -> ItemState {
            ItemState {
                conflict: true,
                ..item(rel, true, Some(1))
            }
        }

        #[test]
        fn a_stale_rounds_conflicts_never_reach_a_newer_view() {
            // The race: an old query's in-flight round completes after
            // teardown (epoch 0) or after a newer install (epoch 2). Either
            // way it must fold into nothing — a candidate sweep trusting a
            // poisoned or resurrected view would skip real conflicts.
            let mut view = ConflictView {
                epoch: 2,
                authoritative: true,
                gathered: false,
                paths: HashSet::new(),
            };
            fold_conflicts_into_view(&mut view, 1, &[conflicted_item("notes/a.md")], &[], true);
            assert!(!view.gathered, "a stale gather must not declare readiness");
            assert!(view.paths.is_empty());
        }

        #[test]
        fn a_current_rounds_rebuild_replaces_and_seeds_the_view() {
            let mut view = ConflictView {
                epoch: 3,
                authoritative: true,
                gathered: false,
                paths: HashSet::from(["notes/stale.md".to_string()]),
            };
            fold_conflicts_into_view(&mut view, 3, &[conflicted_item("notes/a.md")], &[], true);
            assert!(view.gathered);
            assert_eq!(view.paths, HashSet::from(["notes/a.md".to_string()]));

            // A later delta of the same epoch edits in place without
            // touching readiness.
            fold_conflicts_into_view(
                &mut view,
                3,
                &[item("notes/a.md", true, Some(2))],
                &["notes/b.md".to_string()],
                false,
            );
            assert!(view.gathered);
            assert!(view.paths.is_empty());
        }

        #[test]
        fn conflict_set_tracks_flags_across_rounds() {
            let mut conflicted: HashSet<String> = HashSet::new();
            let mut flagged = item("notes/a.md", true, Some(1));
            flagged.conflict = true;

            // A flagged report enters the set and stays across later rounds
            // that don't mention the path.
            apply_conflict_delta(&mut conflicted, std::slice::from_ref(&flagged), &[]);
            apply_conflict_delta(
                &mut conflicted,
                &[item("notes/other.md", true, Some(2))],
                &[],
            );
            assert!(conflicted.contains("notes/a.md"));

            // Resolution (the flag dropping) leaves the set…
            apply_conflict_delta(&mut conflicted, &[item("notes/a.md", true, Some(3))], &[]);
            assert!(!conflicted.contains("notes/a.md"));

            // …and so does the file disappearing from the listing.
            apply_conflict_delta(&mut conflicted, std::slice::from_ref(&flagged), &[]);
            apply_conflict_delta(&mut conflicted, &[], &["notes/a.md".to_string()]);
            assert!(conflicted.is_empty());
        }

        #[test]
        fn upserts_need_local_bytes_and_a_new_mtime() {
            // A full listing applied as a delta (how `full_round` uses it):
            // every listed item upserts, removes come precomputed.
            let mut snapshot = state(&[("notes/same.md", local(1))]);
            let listing = vec![
                item("notes/same.md", true, Some(1)),    // unchanged: no event
                item("notes/changed.md", true, Some(2)), // new content: upsert
                item("notes/stub.md", false, Some(9)),   // not downloaded: no event
            ];
            assert_eq!(
                shapes(&apply_update_delta(&mut snapshot, &listing, &[])),
                vec![(
                    "notes/changed.md".to_string(),
                    "upsert".to_string(),
                    Some(2)
                )]
            );
        }

        #[test]
        fn eviction_is_not_deletion_but_disappearance_is() {
            let mut snapshot = state(&[
                ("notes/evicted.md", local(1)),
                ("notes/deleted.md", local(1)),
            ]);
            // The evicted note stays listed placeholder-state; the deleted one
            // is gone from the listing entirely.
            let listing = vec![item("notes/evicted.md", false, None)];
            let removed = vec!["notes/deleted.md".to_string()];
            assert_eq!(
                shapes(&apply_update_delta(&mut snapshot, &listing, &removed)),
                vec![("notes/deleted.md".to_string(), "remove".to_string(), None)]
            );
        }

        #[test]
        fn plan_nudges_requests_an_arrival_once() {
            let mut nudged: HashMap<String, Option<u64>> = HashMap::new();
            let snapshot = state(&[]);
            let stub = item("notes/a.md", false, Some(5));

            // First sighting of unknown content: request it. Every later
            // round with the same content date: already marked.
            assert_eq!(
                plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&stub)),
                vec!["/container/Notes/notes/a.md".to_string()]
            );
            assert!(plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&stub)).is_empty());

            // Completion clears the mark.
            let downloaded = item("notes/a.md", true, Some(5));
            assert!(
                plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&downloaded)).is_empty()
            );
            assert!(!nudged.contains_key("notes/a.md"));
        }

        #[test]
        fn plan_nudges_leaves_evictions_alone() {
            // The OS evicted content we already saw locally: same content
            // date, bytes offloaded. Re-requesting it would fight Optimize
            // Storage — the eviction must be silent.
            let mut nudged: HashMap<String, Option<u64>> = HashMap::new();
            let snapshot = state(&[("notes/a.md", local(5))]);
            let evictee = item("notes/a.md", false, Some(5));
            assert!(plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&evictee)).is_empty());
        }

        #[test]
        fn plan_nudges_stays_silent_when_the_content_date_is_unknown() {
            let mut nudged: HashMap<String, Option<u64>> = HashMap::new();
            // An eviction reported without a content-change date must not
            // read as "missing" — that would re-request what the OS just
            // offloaded, the exact tug-of-war the policy forbids. A missed
            // real edit is caught by the reconcile's mtime comparison.
            let snapshot = state(&[("notes/a.md", local(5)), ("notes/b.md", evicted(None))]);
            let dateless = item("notes/a.md", false, None);
            assert!(
                plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&dateless)).is_empty()
            );
            // A date appearing on an item whose previous date was unknown is
            // metadata arriving, not a provable remote edit — silent too.
            let dated = item("notes/b.md", false, Some(7));
            assert!(plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&dated)).is_empty());
        }

        #[test]
        fn plan_nudges_requests_a_remote_edit_reaching_an_evicted_item() {
            let mut nudged: HashMap<String, Option<u64>> = HashMap::new();
            // Already evicted at content date 5; the cloud now reports 7 — a
            // remote edit whose bytes this device lacks.
            let snapshot = state(&[("notes/a.md", evicted(Some(5)))]);
            let edited = item("notes/a.md", false, Some(7));
            assert_eq!(
                plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&edited)),
                vec!["/container/Notes/notes/a.md".to_string()]
            );
            // The same report again: already requested for date 7.
            let snapshot = state(&[("notes/a.md", evicted(Some(7)))]);
            assert!(plan_nudges(&mut nudged, &snapshot, std::slice::from_ref(&edited)).is_empty());
        }

        #[test]
        fn update_delta_applies_incrementally_with_the_same_rules() {
            let mut snapshot = state(&[
                ("notes/same.md", local(1)),
                ("notes/evictee.md", local(3)),
                ("notes/deleted.md", local(4)),
            ]);
            let upserted = vec![
                item("notes/same.md", true, Some(1)), // unchanged mtime: no event
                item("notes/changed.md", true, Some(2)), // new content: upsert
                item("notes/stub.md", false, Some(9)), // placeholder: tracked, silent
                item("notes/evictee.md", false, Some(3)), // eviction: silent, stays listed
            ];
            let removed = vec![
                "notes/deleted.md".to_string(),
                "notes/unknown.md".to_string(), // never tracked: no event
            ];
            let changes = apply_update_delta(&mut snapshot, &upserted, &removed);
            assert_eq!(
                shapes(&changes),
                vec![
                    (
                        "notes/changed.md".to_string(),
                        "upsert".to_string(),
                        Some(2)
                    ),
                    ("notes/deleted.md".to_string(), "remove".to_string(), None),
                ]
            );
            // The snapshot now carries the delta: the placeholder and the
            // evictee as evicted (content dates preserved for the changed-only
            // nudge), the arrival's mtime, and no deleted row — exactly what
            // a later round must diff against.
            assert_eq!(
                snapshot,
                state(&[
                    ("notes/same.md", local(1)),
                    ("notes/changed.md", local(2)),
                    ("notes/stub.md", evicted(Some(9))),
                    ("notes/evictee.md", evicted(Some(3))),
                ])
            );
        }

        #[test]
        fn a_download_completion_in_an_update_upserts_once() {
            let mut snapshot = state(&[("notes/a.md", evicted(None))]);
            let changes =
                apply_update_delta(&mut snapshot, &[item("notes/a.md", true, Some(5))], &[]);
            assert_eq!(
                shapes(&changes),
                vec![("notes/a.md".to_string(), "upsert".to_string(), Some(5))]
            );
            // The same completion reported again (e.g. an attribute-only
            // change round) is snapshot-equal — no duplicate event.
            let changes =
                apply_update_delta(&mut snapshot, &[item("notes/a.md", true, Some(5))], &[]);
            assert!(changes.is_empty());
        }

        #[test]
        fn root_variants_are_slash_terminated_and_include_the_canonical_twin() {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path().to_string_lossy().into_owned();
            let variants = root_variants(&root);
            assert_eq!(variants[0], format!("{root}/"));
            assert!(variants.iter().all(|variant| variant.ends_with('/')));
            // macOS tempdirs live behind the /var → /private/var symlink; the
            // canonical twin must be present (deduped when root is already
            // canonical).
            let canonical = std::fs::canonicalize(dir.path()).expect("canonicalize");
            let canonical = format!("{}/", canonical.to_string_lossy());
            assert!(variants.contains(&canonical));
            let unique: std::collections::BTreeSet<&String> = variants.iter().collect();
            assert_eq!(unique.len(), variants.len(), "variants must not repeat");
        }

        #[test]
        fn tracks_notes_relative_to_any_root_variant() {
            let roots = vec![
                "/var/mobile/Containers/Notes/".to_string(),
                "/private/var/mobile/Containers/Notes/".to_string(),
            ];
            // Spotlight may report the resolved (/private) side of the root
            // symlink; either variant must strip.
            assert_eq!(
                tracked_note_relpath("/var/mobile/Containers/Notes/daily/2026-07-04.md", &roots),
                Some("daily/2026-07-04.md".to_string())
            );
            assert_eq!(
                tracked_note_relpath("/private/var/mobile/Containers/Notes/notes/idea.md", &roots),
                Some("notes/idea.md".to_string())
            );
            assert_eq!(
                tracked_note_relpath("/var/mobile/Containers/Notes/.reflect/index.sqlite", &roots),
                None
            );
            assert_eq!(tracked_note_relpath("/elsewhere/notes/a.md", &roots), None);
            // A sibling directory sharing the root as a string prefix is not
            // inside the graph — the slash-terminated variant refuses it.
            assert_eq!(
                tracked_note_relpath("/var/mobile/Containers/Notes-old/notes/a.md", &roots),
                None
            );
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod platform {
    use crate::error::AppResult;

    /// No iCloud metadata queries off Apple platforms — honest no-ops so the
    /// command surface never branches.
    pub fn start(
        _app: tauri::AppHandle,
        _root: String,
        _emit_file_changes: bool,
        _authoritative: bool,
    ) -> AppResult<()> {
        Ok(())
    }

    pub fn stop(_app: tauri::AppHandle) -> AppResult<()> {
        Ok(())
    }

    /// No query, no view — "unknown", so scoped sweeps fall back to full.
    pub(crate) fn conflicted_paths() -> Option<std::collections::HashSet<String>> {
        None
    }
}
