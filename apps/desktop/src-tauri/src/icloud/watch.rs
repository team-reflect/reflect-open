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

use crate::error::AppResult;

/// Command: watch the graph at `root` for iCloud changes. `emit_file_changes`
/// turns snapshot diffs into `index:changed` events — pass `true` on mobile
/// (no watcher there), `false` on desktop (the `notify` watcher already
/// reports file events; double delivery is harmless but wasteful). Conflict
/// paths always emit as `icloud:conflicts`.
#[tauri::command]
pub fn icloud_watch_start(
    root: String,
    emit_file_changes: bool,
    app: tauri::AppHandle,
) -> AppResult<()> {
    platform::start(app, root, emit_file_changes)
}

/// Command: stop the active watch (graph switch or shutdown). Idempotent.
#[tauri::command]
pub fn icloud_watch_stop(app: tauri::AppHandle) -> AppResult<()> {
    platform::stop(app)
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

    /// Last reported state per graph-relative path: `Some(mtime)` when the
    /// content is local, `None` while it is a placeholder (listed, not
    /// downloaded). Plain Rust — safe to touch from the delivery queue.
    static SNAPSHOT: LazyLock<Mutex<HashMap<String, Option<u64>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Graph-relative paths whose download this watch already requested.
    /// The OS treats repeat requests as no-ops, but *issuing* them is not
    /// free: during an initial sync every update round used to re-request
    /// every still-pending placeholder — O(N) `NSFileManager` calls per
    /// round, O(N²) across a large download. Each path is nudged once;
    /// completion (or removal) clears it so a later eviction can re-nudge.
    /// A download that silently stalls is retried by the resume-path
    /// `icloud_download_pending` walk, which requests unconditionally.
    static NUDGED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

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

    pub fn start(app: tauri::AppHandle, root: String, emit_file_changes: bool) -> AppResult<()> {
        use std::sync::atomic::Ordering;
        let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
        let handle = app.clone();
        app.run_on_main_thread(move || install(handle, root, emit_file_changes, epoch))
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
    fn install(app: tauri::AppHandle, root: String, emit_file_changes: bool, epoch: u64) {
        use std::sync::atomic::Ordering;
        let mtm = MainThreadMarker::new().expect("run_on_main_thread is the main thread");
        teardown_active(mtm);
        if EPOCH.load(Ordering::SeqCst) != epoch {
            return; // superseded while queued — a newer install/stop owns the lifecycle
        }
        SNAPSHOT.lock().expect("snapshot lock").clear();
        NUDGED.lock().expect("nudge lock").clear();
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
        unsafe { query.setOperationQueue(Some(&queue)) };

        let handler_roots = roots.clone();
        let handler_root = std::path::PathBuf::from(&root);
        let emit_app = app.clone();
        let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
            handle_notification(
                &app,
                &handler_roots,
                &handler_root,
                emit_file_changes,
                notification,
            );
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
        /// The snapshot value for this item: `Some(mtime)` once local,
        /// `None` while a placeholder.
        fn snapshot_state(&self) -> Option<u64> {
            self.downloaded.then(|| self.mtime.unwrap_or(0))
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

    /// Pure half of the nudge bookkeeping: mark placeholders not yet nudged
    /// this watch (returning their absolute paths, for the caller to
    /// request), and clear completed ones so a later eviction re-nudges.
    fn plan_nudges(nudged: &mut HashSet<String>, items: &[ItemState]) -> Vec<String> {
        let mut request: Vec<String> = Vec::new();
        for item in items {
            if item.downloaded {
                nudged.remove(&item.rel);
            } else if nudged.insert(item.rel.clone()) {
                request.push(item.abs.clone());
            }
        }
        request
    }

    /// Request downloads for the placeholders [`plan_nudges`] marked.
    fn nudge_pending(items: &[ItemState]) {
        let request = {
            let mut nudged = NUDGED.lock().expect("nudge lock");
            plan_nudges(&mut nudged, items)
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

    /// One gathering/update round. Updates apply the notification's own
    /// added/changed/removed delta — O(changed items); a full results
    /// enumeration here would be O(all items) per round, O(n²) across an
    /// initial mass download. The gather round (and an update without a
    /// usable delta) still snapshots the full listing.
    fn handle_notification(
        app: &tauri::AppHandle,
        roots: &[String],
        graph_root: &std::path::Path,
        emit_file_changes: bool,
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
                Some((upserted, removed)) => update_round(&upserted, &removed),
                None => full_round(&query, roots),
            }
        } else {
            full_round(&query, roots)
        };

        let graph = app.state::<crate::fs::GraphState>();
        if emit_file_changes {
            // On iOS this metadata query is the sole external-change source.
            // Placeholder eviction emits no `index:changed` row by design,
            // but attachment resolvers must still drop their cached positive
            // match until the bytes materialize again.
            crate::fs::invalidate_file_catalog_and_emit(app, &graph, graph_root);
        } else {
            // Desktop's recursive filesystem watcher emits the catalog event;
            // avoid a second whole-vault attachment refresh for the same write.
            crate::fs::invalidate_file_catalog(&graph, graph_root);
        }

        if emit_file_changes && !round.changes.is_empty() {
            let _ = app.emit("index:changed", round.changes);
        }
        if !round.conflicts.is_empty() {
            let mut conflicts = round.conflicts;
            conflicts.sort();
            let _ = app.emit("icloud:conflicts", conflicts);
        }
    }

    /// Apply one update notification's delta: nudge new placeholders, fold
    /// the delta into the snapshot, and drop nudge marks for removed items.
    fn update_round(upserted: &[ItemState], removed: &[String]) -> Round {
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
        Round {
            changes,
            conflicts: conflicted_rels(upserted),
        }
    }

    /// Snapshot the query's full results listing — the gather round, and the
    /// fallback for an update notification without a usable delta. Expressed
    /// through [`apply_update_delta`] (every listed item as an upsert, every
    /// snapshot row missing from the listing as a remove) so the full and
    /// incremental paths share one set of diff rules and can never drift.
    fn full_round(query: &NSMetadataQuery, roots: &[String]) -> Round {
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

        nudge_pending(&items);
        let listed: HashSet<&str> = items.iter().map(|item| item.rel.as_str()).collect();
        {
            // Placeholders that vanished from the listing can't complete —
            // drop their nudge marks along with the snapshot rows.
            let mut nudged = NUDGED.lock().expect("nudge lock");
            nudged.retain(|rel| listed.contains(rel.as_str()));
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
        snapshot: &mut HashMap<String, Option<u64>>,
        upserted: &[ItemState],
        removed: &[String],
    ) -> Vec<FileChange> {
        let mut changes: Vec<FileChange> = Vec::new();
        for item in upserted {
            let state = item.snapshot_state();
            let previous = snapshot.insert(item.rel.clone(), state);
            let Some(mtime) = state else {
                continue; // placeholder (or eviction): bytes aren't local
            };
            if previous.flatten() != Some(mtime) {
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

    /// The watcher's note-tracking rule, over absolute metadata paths:
    /// eligible `.md` anywhere in the graph. Tries
    /// every root variant — Spotlight may report either side of the
    /// `/var` ↔ `/private/var` symlink. Variants are slash-terminated
    /// ([`root_variants`]), so the strip is a path boundary, not a string
    /// prefix — a sibling `…/Notes-old/` can never masquerade as the graph.
    fn tracked_note_relpath(path: &str, roots: &[String]) -> Option<String> {
        let rel = roots
            .iter()
            .find_map(|root| path.strip_prefix(root.as_str()))?;
        let tracked = reflect_graph_paths::classify_normalized(rel)
            == Some(reflect_graph_paths::GraphPathKind::Note);
        tracked.then(|| rel.to_string())
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
            apply_update_delta, plan_nudges, root_variants, tracked_note_relpath, ItemState,
        };
        use std::collections::{HashMap, HashSet};

        fn state(entries: &[(&str, Option<u64>)]) -> HashMap<String, Option<u64>> {
            entries
                .iter()
                .map(|(rel, mtime)| (rel.to_string(), *mtime))
                .collect()
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

        #[test]
        fn upserts_need_local_bytes_and_a_new_mtime() {
            // A full listing applied as a delta (how `full_round` uses it):
            // every listed item upserts, removes come precomputed.
            let mut snapshot = state(&[("notes/same.md", Some(1))]);
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
            let mut snapshot =
                state(&[("notes/evicted.md", Some(1)), ("notes/deleted.md", Some(1))]);
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
        fn plan_nudges_requests_each_placeholder_once() {
            let mut nudged: HashSet<String> = HashSet::new();
            let stub = item("notes/a.md", false, None);

            // First sighting: request it. Every later round: already marked.
            assert_eq!(
                plan_nudges(&mut nudged, std::slice::from_ref(&stub)),
                vec!["/container/Notes/notes/a.md".to_string()]
            );
            assert!(plan_nudges(&mut nudged, std::slice::from_ref(&stub)).is_empty());

            // Completion clears the mark, so a later eviction re-nudges.
            let downloaded = item("notes/a.md", true, Some(5));
            assert!(plan_nudges(&mut nudged, std::slice::from_ref(&downloaded)).is_empty());
            assert!(!nudged.contains("notes/a.md"));
            assert_eq!(
                plan_nudges(&mut nudged, std::slice::from_ref(&stub)),
                vec!["/container/Notes/notes/a.md".to_string()]
            );
        }

        #[test]
        fn update_delta_applies_incrementally_with_the_same_rules() {
            let mut snapshot = state(&[
                ("notes/same.md", Some(1)),
                ("notes/evictee.md", Some(3)),
                ("notes/deleted.md", Some(4)),
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
            // evictee as `None`, the arrival's mtime, and no deleted row —
            // exactly what a later full round must diff against.
            assert_eq!(
                snapshot,
                state(&[
                    ("notes/same.md", Some(1)),
                    ("notes/changed.md", Some(2)),
                    ("notes/stub.md", None),
                    ("notes/evictee.md", None),
                ])
            );
        }

        #[test]
        fn a_download_completion_in_an_update_upserts_once() {
            let mut snapshot = state(&[("notes/a.md", None)]);
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
                tracked_note_relpath("/var/mobile/Containers/Notes/README.md", &roots),
                Some("README.md".to_string())
            );
            assert_eq!(
                tracked_note_relpath("/var/mobile/Containers/Notes/Projects/deep/plan.md", &roots),
                Some("Projects/deep/plan.md".to_string())
            );
            assert_eq!(
                tracked_note_relpath("/var/mobile/Containers/Notes/assets/caption.md", &roots),
                None
            );
            assert_eq!(
                tracked_note_relpath("/var/mobile/Containers/Notes/.hidden/a.md", &roots),
                None
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
    pub fn start(_app: tauri::AppHandle, _root: String, _emit_file_changes: bool) -> AppResult<()> {
        Ok(())
    }

    pub fn stop(_app: tauri::AppHandle) -> AppResult<()> {
        Ok(())
    }
}
