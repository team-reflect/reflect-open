//! The SQLite index commands (Plan 04): thin wrappers over
//! [`reflect_index::IndexSession`].
//!
//! The session owns the connections, the generation gate and every
//! transaction. This module adds the iOS background assertion a write holds
//! before it takes the SQLite lock, the thread a read runs on, the
//! `index:committed` / `note:moved` broadcasts after a committed write, and
//! the repair of a corrupt index file after a failed command.

use std::path::PathBuf;
use std::sync::Arc;

use reflect_index::{FileIndexConnections, IndexCommands, IndexEvents};
use reflect_types::events::{EventName, IndexCommitted};
use reflect_types::{AppError, AppResult, NoteMoveRequest, ReconcileScan};

use crate::{Core, Reply, background_task};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl IndexEvents for Core {
    fn index_committed(&self, commit: &IndexCommitted) {
        self.host().emit(
            EventName::IndexCommitted.as_str(),
            serde_json::json!(commit),
        );
    }

    fn note_moved(&self, from: &str, to: &str) {
        self.emit_note_moved(from, to);
    }
}

impl Core {
    /// Runs an `index_write` or `index_read` command of the command table.
    ///
    /// A read runs on the blocking pool, on the session's read-only
    /// connection: a long FTS scan on the caller's thread reads as a frozen
    /// app on iOS, and it never holds the writer lock.
    pub(crate) async fn dispatch_index(
        self: &Arc<Self>,
        command: &str,
        args_json: &[u8],
    ) -> AppResult<Reply> {
        if reflect_index::INDEX_READ_COMMANDS.contains(&command) {
            // Pin the index session before the hop: a graph switch can rebind
            // the index between invoke and execution, and a query issued for
            // graph A must not return graph B's rows.
            let read_generation = self.index.read_generation()?;
            let core = Arc::clone(self);
            let command = command.to_owned();
            let args_json = args_json.to_vec();
            return self
                .spawn_blocking(move || {
                    core.repair_index(
                        read_generation,
                        IndexCommands::new(&core.index, core.as_ref(), read_generation)
                            .dispatch(&command, &args_json),
                    )
                })
                .await
                .map(Reply::Json);
        }
        let _background_task = background_task::scoped(&self.background_tasks, command);
        // A write takes no reader lock: a long query never delays it.
        let generation = self.index.current_generation()?.unwrap_or(0);
        self.repair_index(
            generation,
            IndexCommands::new(&self.index, self.as_ref(), 0).dispatch(command, args_json),
        )
        .map(Reply::Json)
    }

    /// Resets the index file when `result` failed because the file of
    /// `generation` is corrupt (see [`reflect_index::IndexSession::repair`]),
    /// then emits `index:reconcile`.
    pub(crate) fn repair_index<T>(&self, generation: u64, result: AppResult<T>) -> AppResult<T> {
        if let Err(err) = &result
            && self.index.repair(generation, err)
        {
            self.host()
                .emit(EventName::IndexReconcile.as_str(), serde_json::Value::Null);
        }
        result
    }

    fn emit_note_moved(&self, from: &str, to: &str) {
        self.host().emit(
            EventName::NoteMoved.as_str(),
            serde_json::json!({ "from": from, "to": to }),
        );
    }

    /// Command: open + migrate the index for the active graph (reads the root
    /// from state). Returns the new generation, which write commands must echo
    /// back.
    pub fn index_open(&self) -> AppResult<u64> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index open");
        let root: PathBuf = self
            .graph
            .0
            .lock()
            .map_err(|err| {
                tracing::error!(?err, "graph state lock poisoned by an earlier panic");
                AppError::io("graph state lock poisoned")
            })?
            .root
            .clone()
            .ok_or_else(AppError::no_graph)?;
        self.index.open(&root, &FileIndexConnections)
    }

    /// Command: move a note file **and** its projection in one step (Plan 17).
    /// `generation` is the **graph** generation (the same gate as
    /// `note_write`): a rename is user-initiated file mutation, and a stale UI
    /// must be rejected loudly. The rename pipeline end-to-end:
    /// `docs/readable-filenames.md`.
    pub fn note_move_indexed(&self, request: NoteMoveRequest, generation: u64) -> AppResult<()> {
        let _background_task = background_task::scoped(&self.background_tasks, "Reflect note move");
        let root = reflect_graph_io::root_for_generation(&self.graph, generation)?;
        let index_generation = self.index.current_generation()?.unwrap_or(0);
        let moved = reflect_graph_io::with_graph_lock(&root, || {
            reflect_graph_io::root_for_generation(&self.graph, generation)?;
            self.index.move_note(&root, &request, || {
                reflect_graph_io::move_note_file(&root, &request.from, &request.to)
            })
        });
        let seq = self.repair_index(index_generation, moved)?;
        reflect_graph_io::invalidate_file_catalog(&self.graph, &root);
        self.index_committed(&IndexCommitted {
            seq,
            paths: Some(vec![request.from.clone(), request.to.clone()]),
        });
        self.emit_note_moved(&request.from, &request.to);
        Ok(())
    }

    /// Command: compute the open-path reconcile delta natively: list the
    /// graph's notes, compare against the stored rows, and return only what
    /// needs work. The walk runs **without** the index lock held, so thousands
    /// of stats never block concurrent reads. A stale generation returns the
    /// empty scan.
    pub async fn index_reconcile_scan(
        self: &Arc<Self>,
        generation: u64,
    ) -> AppResult<ReconcileScan> {
        // Async on purpose: this is one uninterruptible O(graph) walk + table
        // read, and as a sync command it occupied the iOS main thread — the
        // post-paint "I can see a note but can't tap it" freeze on every open.
        let core = Arc::clone(self);
        self.spawn_blocking(move || {
            let started = std::time::Instant::now();
            let Some(root) = core.index.root_for_generation(generation)? else {
                return Ok(ReconcileScan::default());
            };
            let walk_started = std::time::Instant::now();
            let files = reflect_graph_io::note_files(&root);
            let walk_ms = walk_started.elapsed().as_millis() as u64;
            let scan = core.repair_index(
                generation,
                core.index.reconcile_scan(generation, &files, now_ms()),
            )?;
            tracing::info!(
                files = scan.total,
                candidates = scan.candidates.len(),
                orphans = scan.orphans.len(),
                walk_ms,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "index_reconcile_scan"
            );
            Ok(scan)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Value;

    use super::*;
    use crate::{CoreConfig, Host, Reply};

    #[derive(Default)]
    struct RecordingHost {
        events: Mutex<Vec<(String, Value)>>,
    }

    impl Host for RecordingHost {
        fn emit(&self, event: &str, payload: Value) {
            self.events.lock().unwrap().push((event.into(), payload));
        }

        fn run_on_main(&self, task: Box<dyn FnOnce() + Send>) -> AppResult<()> {
            task();
            Ok(())
        }

        fn open_url(&self, _url: &str) -> AppResult<()> {
            Ok(())
        }

        #[cfg(not(target_os = "ios"))]
        fn reveal_path(&self, _path: &std::path::Path) -> AppResult<()> {
            Ok(())
        }
    }

    #[test]
    fn dispatch_opens_writes_and_reads_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(RecordingHost::default());
        let core = Arc::new(Core::new(CoreConfig::default(), host.clone()).unwrap());
        reflect_graph_io::activate(&core.graph, dir.path()).unwrap();
        core.runtime.block_on(async {
            let Reply::Json(generation) = core
                .dispatch("index_open", b"{}", b"{}", None)
                .await
                .unwrap()
            else {
                panic!("expected JSON");
            };
            let args = format!(r#"{{"generation":{generation}}}"#);
            core.dispatch("index_clear", args.as_bytes(), b"{}", None)
                .await
                .unwrap();
            assert_eq!(*host.events.lock().unwrap(), []);
            let args = format!(r#"{{"seq":1,"paths":["notes/a.md"],"generation":{generation}}}"#);
            core.dispatch("index_announce", args.as_bytes(), b"{}", None)
                .await
                .unwrap();
            assert_eq!(
                *host.events.lock().unwrap(),
                [(
                    EventName::IndexCommitted.as_str().to_string(),
                    serde_json::json!({ "seq": 1, "paths": ["notes/a.md"] })
                )]
            );
            assert_eq!(
                core.dispatch("index_meta_get", br#"{"key":"k"}"#, b"{}", None)
                    .await
                    .unwrap(),
                Reply::Json("null".into())
            );
        });
    }

    #[test]
    fn a_corrupt_index_is_reset_once_and_reconciled() {
        let dir = tempfile::tempdir().unwrap();
        let open = |host: &Arc<RecordingHost>| {
            let core = Arc::new(Core::new(CoreConfig::default(), host.clone()).unwrap());
            reflect_graph_io::activate(&core.graph, dir.path()).unwrap();
            let Reply::Json(generation) = core
                .runtime
                .block_on(core.dispatch("index_open", b"{}", b"{}", None))
                .unwrap()
            else {
                panic!("expected JSON");
            };
            (core, generation)
        };
        let host = Arc::new(RecordingHost::default());
        let (core, generation) = open(&host);
        let args = format!(r#"{{"key":"k","value":"v","generation":{generation}}}"#);
        core.runtime
            .block_on(core.dispatch("index_meta_set", args.as_bytes(), b"{}", None))
            .unwrap();
        drop(core);
        // Damage the root page of `index_meta` only, so the open still succeeds.
        let path = dir.path().join(".reflect/index.sqlite");
        let (page, page_size): (u32, u32) = rusqlite::Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT rootpage, (SELECT page_size FROM pragma_page_size()) FROM sqlite_master \
                 WHERE name = 'index_meta'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        let (page, page_size) = (page as usize, page_size as usize);
        bytes[(page - 1) * page_size..page * page_size].fill(0xA5);
        std::fs::write(&path, bytes).unwrap();

        let host = Arc::new(RecordingHost::default());
        let (core, _) = open(&host);
        let get = || {
            core.runtime
                .block_on(core.dispatch("index_meta_get", br#"{"key":"k"}"#, b"{}", None))
        };
        assert!(get().is_err());
        assert_eq!(get().unwrap(), Reply::Json("null".into()));
        let reconciles = host
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, _)| event == reflect_types::events::EventName::IndexReconcile.as_str())
            .count();
        assert_eq!(reconciles, 1);
    }
}
