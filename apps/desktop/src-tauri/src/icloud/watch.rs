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
    use std::collections::HashMap;
    use std::ptr::NonNull;
    use std::sync::{LazyLock, Mutex};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use dispatch2::MainThreadBound;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_foundation::{
        NSArray, NSDate, NSMetadataItem, NSMetadataItemFSContentChangeDateKey,
        NSMetadataItemPathKey, NSMetadataQuery, NSMetadataQueryDidFinishGatheringNotification,
        NSMetadataQueryDidUpdateNotification, NSMetadataQueryUbiquitousDocumentsScope,
        NSMetadataUbiquitousItemDownloadingStatusCurrent,
        NSMetadataUbiquitousItemDownloadingStatusKey,
        NSMetadataUbiquitousItemHasUnresolvedConflictsKey, NSNotification, NSNotificationCenter,
        NSCopying, NSNumber, NSOperationQueue, NSPredicate, NSString,
    };
    use serde::Serialize;
    use tauri::Emitter;

    use crate::error::{AppError, AppResult};

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

    /// The watcher's change event, matching `watcher::FileChange`.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FileChange {
        path: String,
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        modified_ms: Option<u64>,
    }

    pub fn start(app: tauri::AppHandle, root: String, emit_file_changes: bool) -> AppResult<()> {
        stop(app.clone())?;
        SNAPSHOT.lock().expect("snapshot lock").clear();
        let handle = app.clone();
        app.run_on_main_thread(move || install(handle, root, emit_file_changes))
            .map_err(|err| AppError::io(format!("failed to reach the main thread: {err}")))
    }

    pub fn stop(app: tauri::AppHandle) -> AppResult<()> {
        let Some(bound) = ACTIVE.lock().expect("watch lock").take() else {
            return Ok(());
        };
        app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new().expect("run_on_main_thread is the main thread");
            let watch = bound.into_inner(mtm);
            watch.query.stopQuery();
            let center = NSNotificationCenter::defaultCenter();
            for token in &watch.tokens {
                unsafe {
                    let _: () = msg_send![&center, removeObserver: &**token];
                }
            }
        })
        .map_err(|err| AppError::io(format!("failed to reach the main thread: {err}")))
    }

    /// Build, wire, and start the query. Main thread only.
    fn install(app: tauri::AppHandle, root: String, emit_file_changes: bool) {
        let mtm = MainThreadMarker::new().expect("run_on_main_thread is the main thread");
        let query = NSMetadataQuery::new();

        let scope: Retained<NSString> =
            unsafe { NSMetadataQueryUbiquitousDocumentsScope.copy() };
        let scopes = NSArray::from_retained_slice(&[scope]);
        // setSearchScopes/argumentArray take untyped NSArrays the bindings
        // can't coerce typed arrays into — message directly.
        unsafe {
            let _: () = msg_send![&query, setSearchScopes: &*scopes];
        }

        let format = NSString::from_str("%K BEGINSWITH %@");
        let path_key: Retained<NSString> = unsafe { NSMetadataItemPathKey.copy() };
        let root_ns = NSString::from_str(&root);
        let args = NSArray::from_retained_slice(&[path_key, root_ns]);
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

        let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
            handle_notification(&app, &root, emit_file_changes, notification);
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
            tracing::warn!("iCloud metadata query failed to start");
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

    /// One gathering/update round: snapshot the results, diff, emit.
    fn handle_notification(
        app: &tauri::AppHandle,
        root: &str,
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

        query.disableUpdates();
        let results = query.results();
        let mut current: HashMap<String, Option<u64>> = HashMap::new();
        let mut conflicts: Vec<String> = Vec::new();
        for item in results.iter() {
            let Ok(item) = item.downcast::<NSMetadataItem>() else {
                continue;
            };
            let Some(path) = attr_string(&item, unsafe { NSMetadataItemPathKey }) else {
                continue;
            };
            let Some(rel) = tracked_note_relpath(&path, root) else {
                continue;
            };
            if attr_bool(&item, unsafe { NSMetadataUbiquitousItemHasUnresolvedConflictsKey }) {
                conflicts.push(rel.clone());
            }
            let downloaded = attr_string(&item, unsafe {
                NSMetadataUbiquitousItemDownloadingStatusKey
            })
            .is_some_and(|status| {
                status == unsafe { NSMetadataUbiquitousItemDownloadingStatusCurrent }.to_string()
            });
            let mtime = attr_date_ms(&item, unsafe { NSMetadataItemFSContentChangeDateKey });
            current.insert(rel, if downloaded { Some(mtime.unwrap_or(0)) } else { None });
        }
        query.enableUpdates();

        let mut snapshot = SNAPSHOT.lock().expect("snapshot lock");
        if emit_file_changes {
            let mut changes: Vec<FileChange> = Vec::new();
            for (rel, state) in &current {
                let Some(mtime) = state else {
                    continue; // not downloaded: bytes aren't local, never an upsert
                };
                if snapshot.get(rel).copied().flatten() != Some(*mtime) {
                    changes.push(FileChange {
                        path: rel.clone(),
                        kind: "upsert".to_string(),
                        modified_ms: Some(*mtime),
                    });
                }
            }
            for rel in snapshot.keys() {
                // Absent from the listing entirely = deleted. (Evicted items
                // stay listed with a non-current status — not removes.)
                if !current.contains_key(rel) {
                    changes.push(FileChange {
                        path: rel.clone(),
                        kind: "remove".to_string(),
                        modified_ms: None,
                    });
                }
            }
            if !changes.is_empty() {
                let _ = app.emit("index:changed", changes);
            }
        }
        *snapshot = current;
        drop(snapshot);

        if !conflicts.is_empty() {
            conflicts.sort();
            let _ = app.emit("icloud:conflicts", conflicts);
        }
    }

    /// The watcher's note-tracking rule, over absolute metadata paths:
    /// `.md` under `daily/`, `notes/`, or `templates/`, graph-relative.
    fn tracked_note_relpath(path: &str, root: &str) -> Option<String> {
        let rel = path.strip_prefix(root)?.trim_start_matches('/');
        let tracked = (rel.starts_with("daily/")
            || rel.starts_with("notes/")
            || rel.starts_with("templates/"))
            && rel.ends_with(".md");
        tracked.then(|| rel.to_string())
    }

    fn attr_string(item: &NSMetadataItem, key: &NSString) -> Option<String> {
        let value = item.valueForAttribute(key)?;
        value.downcast::<NSString>().ok().map(|s| s.to_string())
    }

    fn attr_bool(item: &NSMetadataItem, key: &NSString) -> bool {
        item.valueForAttribute(key)
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .map(|number| number.boolValue())
            .unwrap_or(false)
    }

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
        use super::tracked_note_relpath;

        #[test]
        fn tracks_notes_relative_to_the_root() {
            let root = "/container/Documents/Notes";
            assert_eq!(
                tracked_note_relpath("/container/Documents/Notes/daily/2026-07-04.md", root),
                Some("daily/2026-07-04.md".to_string())
            );
            assert_eq!(
                tracked_note_relpath("/container/Documents/Notes/.reflect/index.sqlite", root),
                None
            );
            assert_eq!(
                tracked_note_relpath("/container/Documents/Other/notes/a.md", root),
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
    ) -> AppResult<()> {
        Ok(())
    }

    pub fn stop(_app: tauri::AppHandle) -> AppResult<()> {
        Ok(())
    }
}
