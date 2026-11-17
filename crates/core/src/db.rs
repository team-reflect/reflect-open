//! The SQLite index commands (Plan 04): thin wrappers over
//! [`reflect_index::IndexSession`].
//!
//! The session owns the connections, the generation gate and every
//! transaction. This module adds the iOS background assertion a write holds
//! before it takes the SQLite lock, the thread a read runs on, and the
//! `index:written` / `note:moved` broadcasts after a committed write.

use std::path::PathBuf;
use std::sync::Arc;

use reflect_index::{FileIndexConnections, IndexCommands, IndexEvents};
use reflect_types::{AppError, AppResult, NoteMoveRequest, ReconcileScan};
use serde_json::Value;

use crate::{Core, Reply, background_task};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The iOS background assertion that an index write holds while it has the
/// SQLite lock.
fn background_task_name(command: &str) -> &'static str {
    match command {
        "index_apply" | "index_apply_batch" => "Reflect index update",
        "index_remove" => "Reflect index remove",
        "index_move" => "Reflect index move",
        "index_touch" => "Reflect index touch",
        "index_meta_set" => "Reflect index metadata",
        "index_clear" => "Reflect index clear",
        "chat_message_save" => "Reflect chat save",
        "chat_conversation_delete" => "Reflect chat delete",
        "embed_apply" => "Reflect embeddings update",
        "embed_remove" => "Reflect embeddings remove",
        _ => "Reflect index write",
    }
}

impl IndexEvents for Core {
    fn index_written(&self) {
        self.emit_index_written();
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
                    IndexCommands::new(&core.index, core.as_ref(), read_generation)
                        .dispatch(&command, &args_json)
                })
                .await
                .map(Reply::Json);
        }
        let _background_task =
            background_task::scoped(&self.background_tasks, background_task_name(command));
        // A write takes no reader lock: a long query never delays it.
        IndexCommands::new(&self.index, self.as_ref(), 0)
            .dispatch(command, args_json)
            .map(Reply::Json)
    }

    fn emit_index_written(&self) {
        self.host().emit(
            reflect_types::events::EventName::IndexWritten.as_str(),
            Value::Null,
        );
    }

    fn emit_note_moved(&self, from: &str, to: &str) {
        self.host().emit(
            reflect_types::events::EventName::NoteMoved.as_str(),
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
        reflect_graph_io::with_graph_lock(&root, || {
            reflect_graph_io::root_for_generation(&self.graph, generation)?;
            self.index.move_note(&root, &request, || {
                reflect_graph_io::move_note_file(&root, &request.from, &request.to)
            })
        })?;
        reflect_graph_io::invalidate_file_catalog(&self.graph, &root);
        self.emit_index_written();
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
            let scan = core.index.reconcile_scan(generation, &files, now_ms())?;
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
    fn dispatch_opens_writes_and_queries_the_index() {
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
            assert_eq!(
                *host.events.lock().unwrap(),
                [(
                    reflect_types::events::EventName::IndexWritten
                        .as_str()
                        .to_string(),
                    Value::Null
                )]
            );
            let args = br#"{"sql":"select 1 as one","params":[]}"#;
            assert_eq!(
                core.dispatch("db_query", args, b"{}", None).await.unwrap(),
                Reply::Json(r#"[{"one":1}]"#.into())
            );
        });
    }
}
