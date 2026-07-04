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
    use dispatch2::MainThreadBound;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_foundation::{
        NSArray, NSCopying, NSDate, NSMetadataItem, NSMetadataItemFSContentChangeDateKey,
        NSMetadataItemPathKey, NSMetadataQuery, NSMetadataQueryDidFinishGatheringNotification,
        NSMetadataQueryDidUpdateNotification, NSMetadataQueryUbiquitousDocumentsScope,
        NSMetadataUbiquitousItemDownloadingStatusCurrent,
        NSMetadataUbiquitousItemDownloadingStatusKey,
        NSMetadataUbiquitousItemHasUnresolvedConflictsKey, NSNotification, NSNotificationCenter,
        NSNumber, NSOperationQueue, NSPredicate, NSString,
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

    /// Build, wire, and start the query. Main thread only.
    fn install(app: tauri::AppHandle, root: String, emit_file_changes: bool) {
        let mtm = MainThreadMarker::new().expect("run_on_main_thread is the main thread");
        let query = NSMetadataQuery::new();

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
        let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
            handle_notification(&app, &handler_roots, emit_file_changes, notification);
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

    /// One gathering/update round: snapshot the results, diff, emit.
    fn handle_notification(
        app: &tauri::AppHandle,
        roots: &[String],
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
            let Some(rel) = tracked_note_relpath(&path, roots) else {
                continue;
            };
            if attr_bool(&item, unsafe {
                NSMetadataUbiquitousItemHasUnresolvedConflictsKey
            }) {
                conflicts.push(rel.clone());
            }
            let downloaded = attr_string(&item, unsafe {
                NSMetadataUbiquitousItemDownloadingStatusKey
            })
            .is_some_and(|status| {
                status == unsafe { NSMetadataUbiquitousItemDownloadingStatusCurrent }.to_string()
            });
            let mtime = attr_date_ms(&item, unsafe { NSMetadataItemFSContentChangeDateKey });
            current.insert(
                rel,
                if downloaded {
                    Some(mtime.unwrap_or(0))
                } else {
                    None
                },
            );
        }
        query.enableUpdates();

        let mut snapshot = SNAPSHOT.lock().expect("snapshot lock");
        if emit_file_changes {
            let changes = snapshot_changes(&snapshot, &current);
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

    /// Diff one results listing against the previous snapshot (the pure heart
    /// of [`handle_notification`], kept free of Objective-C so it is unit
    /// testable). Upserts only for content that is **local** (downloaded) and
    /// new or mtime-changed; removes only for paths gone from the listing
    /// entirely. An evicted item stays listed in a placeholder state (`None`)
    /// and produces no event in either direction — eviction is not deletion,
    /// and its bytes aren't local to upsert — until iCloud downloads it again.
    fn snapshot_changes(
        previous: &HashMap<String, Option<u64>>,
        current: &HashMap<String, Option<u64>>,
    ) -> Vec<FileChange> {
        let mut changes: Vec<FileChange> = Vec::new();
        for (rel, state) in current {
            let Some(mtime) = state else {
                continue; // not downloaded: bytes aren't local, never an upsert
            };
            if previous.get(rel).copied().flatten() != Some(*mtime) {
                changes.push(FileChange {
                    path: rel.clone(),
                    kind: "upsert".to_string(),
                    modified_ms: Some(*mtime),
                });
            }
        }
        for rel in previous.keys() {
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
        changes
    }

    /// The watcher's note-tracking rule, over absolute metadata paths:
    /// `.md` under `daily/`, `notes/`, or `templates/`, graph-relative. Tries
    /// every root variant — Spotlight may report either side of the
    /// `/var` ↔ `/private/var` symlink. Variants are slash-terminated
    /// ([`root_variants`]), so the strip is a path boundary, not a string
    /// prefix — a sibling `…/Notes-old/` can never masquerade as the graph.
    fn tracked_note_relpath(path: &str, roots: &[String]) -> Option<String> {
        let rel = roots
            .iter()
            .find_map(|root| path.strip_prefix(root.as_str()))?;
        let tracked = (rel.starts_with("daily/")
            || rel.starts_with("notes/")
            || rel.starts_with("templates/"))
            && rel.ends_with(".md");
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
        use super::{root_variants, snapshot_changes, tracked_note_relpath};
        use std::collections::HashMap;

        fn state(entries: &[(&str, Option<u64>)]) -> HashMap<String, Option<u64>> {
            entries
                .iter()
                .map(|(rel, mtime)| (rel.to_string(), *mtime))
                .collect()
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
            let previous = state(&[("notes/same.md", Some(1))]);
            let current = state(&[
                ("notes/same.md", Some(1)),    // unchanged: no event
                ("notes/changed.md", Some(2)), // new content: upsert
                ("notes/stub.md", None),       // listed but not downloaded: no event
            ]);
            assert_eq!(
                shapes(&snapshot_changes(&previous, &current)),
                vec![(
                    "notes/changed.md".to_string(),
                    "upsert".to_string(),
                    Some(2)
                )]
            );
        }

        #[test]
        fn eviction_is_not_deletion_but_disappearance_is() {
            let previous = state(&[("notes/evicted.md", Some(1)), ("notes/deleted.md", Some(1))]);
            // The evicted note stays listed placeholder-state; the deleted one
            // is gone from the listing entirely.
            let current = state(&[("notes/evicted.md", None)]);
            assert_eq!(
                shapes(&snapshot_changes(&previous, &current)),
                vec![("notes/deleted.md".to_string(), "remove".to_string(), None)]
            );
        }

        #[test]
        fn a_finished_download_upserts_the_note() {
            let previous = state(&[("notes/a.md", None)]);
            let current = state(&[("notes/a.md", Some(5))]);
            assert_eq!(
                shapes(&snapshot_changes(&previous, &current)),
                vec![("notes/a.md".to_string(), "upsert".to_string(), Some(5))]
            );
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
    pub fn start(_app: tauri::AppHandle, _root: String, _emit_file_changes: bool) -> AppResult<()> {
        Ok(())
    }

    pub fn stop(_app: tauri::AppHandle) -> AppResult<()> {
        Ok(())
    }
}
