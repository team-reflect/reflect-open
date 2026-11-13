//! The SQLite index commands (Plan 04): thin wrappers over
//! [`reflect_index::IndexSession`].
//!
//! The session owns the connections, the generation gate and every
//! transaction. This module adds the iOS background assertion a write holds
//! before it takes the SQLite lock, the thread a read runs on, and the
//! `index:written` / `note:moved` broadcasts after a committed write.

use std::path::PathBuf;
use std::sync::Arc;

use reflect_index::{
    Applied, ChatConversation, ChatMessageRow, EmbeddedChunk, FileIndexConnections, IndexTouch,
    IndexedNote, MovedNoteAddress, NoteMoveRequest, ReconcileScan,
};
use reflect_types::{AppError, AppResult};
use serde_json::{Map, Value};

use crate::{Core, background_task};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl Core {
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

    /// Command: apply one note's extracted projection in a single transaction
    /// (no-op if the generation is stale).
    pub fn index_apply(&self, note: IndexedNote, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index update");
        if self.index.apply(generation, std::slice::from_ref(&note))? == Applied::Committed {
            self.emit_index_written();
        }
        Ok(())
    }

    /// Command: apply many notes' projections in one transaction (the
    /// full-rebuild path).
    pub fn index_apply_batch(&self, notes: Vec<IndexedNote>, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index update");
        if self.index.apply(generation, &notes)? == Applied::Committed {
            self.emit_index_written();
        }
        Ok(())
    }

    /// Command: remove a note (e.g. deleted on disk) from the index, embedding
    /// rows included (no-op if stale).
    pub fn index_remove(&self, path: String, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index remove");
        if self.index.remove(generation, &path)? == Applied::Committed {
            self.emit_index_written();
        }
        Ok(())
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

    /// Command: move a note's projection rows **only** (the id-based
    /// reconcile, Plan 17); no-op if the index generation is stale.
    pub fn index_move(
        &self,
        from: String,
        to: String,
        generation: u64,
        to_address: MovedNoteAddress,
    ) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index move");
        if self.index.move_rows(generation, &from, &to, &to_address)? == Applied::Committed {
            self.emit_index_written();
            self.emit_note_moved(&from, &to);
        }
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
                return Ok(ReconcileScan::empty());
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

    /// Command: re-stamp stored mtimes for notes whose content already matches
    /// disk (the reconcile's hash-match skip, no-op if stale).
    pub fn index_touch(&self, entries: Vec<IndexTouch>, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index touch");
        self.index.touch(generation, &entries).map(drop)
    }

    /// Command: upsert one `index_meta` key (no-op if stale). Reads go through
    /// `db_query`.
    pub fn index_meta_set(&self, key: String, value: String, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index metadata");
        self.index.set_meta(generation, &key, &value).map(drop)
    }

    /// Command: wipe all derived tables (the TS layer then re-applies every
    /// note; no-op if stale). Chat history is untouched.
    pub fn index_clear(&self, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect index clear");
        if self.index.clear(generation)? == Applied::Committed {
            self.emit_index_written();
        }
        Ok(())
    }

    /// Command: upsert one chat message and its conversation row (no-op if
    /// stale). A turn detached by a graph switch must not land in the new
    /// graph's history.
    pub fn chat_message_save(
        &self,
        conversation: ChatConversation,
        message: ChatMessageRow,
        generation: u64,
    ) -> AppResult<()> {
        let _background_task = background_task::scoped(&self.background_tasks, "Reflect chat save");
        self.index
            .save_chat_message(generation, &conversation, &message)
            .map(drop)
    }

    /// Command: delete a conversation and (via cascade) its messages (no-op if
    /// stale).
    pub fn chat_conversation_delete(&self, id: String, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect chat delete");
        self.index
            .delete_chat_conversation(generation, &id)
            .map(drop)
    }

    /// Command: replace a note's embedding chunk set (no-op if stale).
    pub fn embed_apply(
        &self,
        path: String,
        chunks: Vec<EmbeddedChunk>,
        generation: u64,
    ) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect embeddings update");
        self.index
            .apply_embeddings(generation, &path, &chunks)
            .map(drop)
    }

    /// Command: drop a deleted note's chunks + vectors (no-op if stale).
    pub fn embed_remove(&self, path: String, generation: u64) -> AppResult<()> {
        let _background_task =
            background_task::scoped(&self.background_tasks, "Reflect embeddings remove");
        self.index.remove_embeddings(generation, &path).map(drop)
    }

    /// Command: execute a read query (compiled by Kysely on the frontend) and
    /// return rows.
    ///
    /// Async on purpose: sync commands run on the main thread, which on iOS
    /// also owns touch delivery — a long FTS scan there reads as a frozen app.
    /// Runs on the session's read-only connection so it never holds the writer
    /// lock a sync write command would block the main thread waiting for.
    pub async fn db_query(
        self: &Arc<Self>,
        sql: String,
        params: Vec<Value>,
    ) -> AppResult<Vec<Map<String, Value>>> {
        // Pin the index session before the hop: with no main-thread FIFO, a
        // graph switch can rebind the index between invoke and execution, and a
        // query issued for graph A must not return graph B's rows.
        let requested = self.index.read_generation()?;
        let core = Arc::clone(self);
        self.spawn_blocking(move || core.index.query(requested, &sql, &params))
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
