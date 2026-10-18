//! The open index session: its connections, its generation, and every write
//! gated on that generation.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{Map, Value};

use reflect_types::{AppError, AppResult, FileMeta};

use crate::chat_write::{self, ChatConversation, ChatMessageRow};
use crate::embed_write::{self, EmbeddedChunk};
use crate::query;
use crate::scan::{self, ReconcileScan};
use crate::write::{self, IndexedNote, MovedNoteAddress};

/// Where a session gets its connections when it opens a root.
pub trait IndexConnections {
    /// The migrated writer.
    fn open_writer(&self, root: &Path) -> AppResult<Connection>;

    /// A second connection for queries, opened after the writer created and
    /// migrated the file. `None` means the host has one connection: queries
    /// then run on the writer.
    fn open_reader(&self, root: &Path) -> AppResult<Option<Connection>>;
}

/// Whether a generation-gated write reached the database.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    /// The transaction committed.
    Committed,
    /// The generation was stale, so nothing was written. A superseded pass
    /// must not write the newly opened index.
    Stale,
}

/// The open index connection plus its monotonic generation, kept **under one
/// lock** so they swap atomically. [`IndexSession::open`] bumps the generation
/// and rebinds the connection together; a write carries the generation it was
/// issued for and no-ops if it's stale. Because the check and the connection
/// are read under the same lock, a write can never see a fresh generation with
/// a stale connection (or vice versa).
#[derive(Default)]
struct WriterInner {
    generation: u64,
    conn: Option<Connection>,
    /// The graph root this generation's index was opened for. Reconcile scans
    /// list *this* root, never the caller's current one: with async callers
    /// there is no ordering between a graph switch and a queued scan, so the
    /// scan could otherwise walk a freshly swapped root and diff another
    /// graph's files against this index.
    root: Option<PathBuf>,
}

/// The query reader: a second, **read-only** connection under its own lock,
/// so a long FTS scan never contends with a write. Under WAL the reader sees
/// the last committed state. It is rebound (with its own generation copy, so
/// the pair swaps atomically for readers of *this* lock) while the writer lock
/// is held; lock order is always writer then reader.
#[derive(Default)]
struct ReaderInner {
    generation: u64,
    conn: Option<Connection>,
    /// The host supplied no reader, so queries take the writer lock instead.
    on_writer: bool,
}

/// The active graph's index (the connections are `None` until [`open`]).
///
/// [`open`]: IndexSession::open
#[derive(Default)]
pub struct IndexSession {
    writer: Mutex<WriterInner>,
    reader: Mutex<ReaderInner>,
}

/// One `touch` entry: re-stamp `path`'s stored mtime to `mtime` (epoch ms, as
/// listed by the file walk).
#[derive(Debug, Deserialize)]
pub struct IndexTouch {
    pub path: String,
    pub mtime: i64,
}

/// One user-initiated move, with the folded addressing for both directions:
/// the destination's for the forward row move, the source's for the
/// compensating reverse move when the disk refuses.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMoveRequest {
    pub from: String,
    pub to: String,
    pub to_address: MovedNoteAddress,
    pub from_address: MovedNoteAddress,
}

impl IndexSession {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock_writer(&self) -> AppResult<MutexGuard<'_, WriterInner>> {
        self.writer.lock().map_err(|err| {
            // A poisoned lock means a caller panicked while holding it; the
            // panic itself is the bug, this names the blast radius.
            tracing::error!(?err, "index state lock poisoned by an earlier panic");
            AppError::io("index state lock poisoned")
        })
    }

    fn lock_reader(&self) -> AppResult<MutexGuard<'_, ReaderInner>> {
        self.reader.lock().map_err(|err| {
            tracing::error!(?err, "index read lock poisoned by an earlier panic");
            AppError::io("index read lock poisoned")
        })
    }

    /// Open and migrate the index under `root`. Returns the new generation,
    /// which every write must echo back. The generation bump and the
    /// connection rebind happen under one lock, atomically.
    pub fn open(&self, root: &Path, connections: &dyn IndexConnections) -> AppResult<u64> {
        let mut writer = self.lock_writer()?;
        writer.generation += 1;
        // Drop the old connections before opening; if an open fails we return
        // with `conn = None` (reads then error) rather than a stale
        // connection. The root is rebound with the writer, under the same
        // lock, so a generation can never pair with another graph's root.
        writer.conn = None;
        writer.root = None;
        {
            let mut reader = self.lock_reader()?;
            reader.conn = None;
        }
        writer.conn = Some(connections.open_writer(root)?);
        let mut reader = self.lock_reader()?;
        let read_conn = match connections.open_reader(root) {
            Ok(conn) => conn,
            Err(err) => {
                // A half-open session (writer bound, no reader) must not
                // survive: drop the writer too, so `current_generation` answers
                // `None` and a write for the bumped generation reports
                // `no_graph` instead of landing in an index nobody can read.
                writer.conn = None;
                return Err(err);
            }
        };
        reader.on_writer = read_conn.is_none();
        reader.conn = read_conn;
        reader.generation = writer.generation;
        writer.root = Some(root.to_path_buf());
        Ok(writer.generation)
    }

    /// The open session's generation as a pure read, or `None` when no index
    /// is open. Adopting a session through this must never rebind the
    /// connection or bump the generation the way [`open`] does.
    ///
    /// [`open`]: IndexSession::open
    pub fn current_generation(&self) -> AppResult<Option<u64>> {
        let writer = self.lock_writer()?;
        Ok(writer.conn.is_some().then_some(writer.generation))
    }

    /// The reader's generation, to pin a query issued now against the session
    /// it runs on later (see [`query`]).
    ///
    /// [`query`]: IndexSession::query
    pub fn read_generation(&self) -> AppResult<u64> {
        Ok(self.lock_reader()?.generation)
    }

    /// The root this generation's index was opened for, or `None` when the
    /// generation is stale or no index is open.
    pub fn root_for_generation(&self, generation: u64) -> AppResult<Option<PathBuf>> {
        let writer = self.lock_writer()?;
        if writer.generation != generation {
            return Ok(None);
        }
        Ok(Some(writer.root.clone().ok_or_else(AppError::no_graph)?))
    }

    /// Run `body` on the writer when `generation` is current.
    fn write<T>(
        &self,
        generation: u64,
        body: impl FnOnce(&mut Connection) -> AppResult<T>,
    ) -> AppResult<Option<T>> {
        let mut writer = self.lock_writer()?;
        if writer.generation != generation {
            return Ok(None);
        }
        let conn = writer.conn.as_mut().ok_or_else(AppError::no_graph)?;
        body(conn).map(Some)
    }

    fn applied(outcome: AppResult<Option<()>>) -> AppResult<Applied> {
        outcome.map(|committed| match committed {
            Some(()) => Applied::Committed,
            None => Applied::Stale,
        })
    }

    /// Apply note projections in one transaction. One transaction plus cached
    /// statements keeps a full rebuild cheap; an empty batch commits a no-op
    /// transaction.
    pub fn apply(&self, generation: u64, notes: &[IndexedNote]) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| {
            let tx = conn.transaction()?;
            for note in notes {
                write::apply_note(&tx, note)?;
            }
            tx.commit()?;
            Ok(())
        }))
    }

    /// Remove a note (e.g. deleted on disk) from the index. This is the
    /// *genuine deletion* entry point, so embedding rows go too; `apply_note`'s
    /// internal remove must NOT do this (it runs on every upsert and would
    /// destroy the chunk hash-skip).
    pub fn remove(&self, generation: u64, path: &str) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| {
            // One transaction: a half-removed note (row gone, chunks left)
            // would let a later note at the same path surface stale chunk text
            // in semantic search until a re-embed.
            let tx = conn.transaction()?;
            write::remove_note(&tx, path)?;
            embed_write::remove_chunks(&tx, path)?;
            tx.commit()?;
            Ok(())
        }))
    }

    /// Move a note's projection rows **only** (the id-based reconcile, Plan
    /// 17): the file already lives at `to`. The rows move rather than being
    /// re-created so embedding vectors survive. Gated on the index generation
    /// like every other reconcile-path write.
    pub fn move_rows(
        &self,
        generation: u64,
        from: &str,
        to: &str,
        address: &MovedNoteAddress,
    ) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| move_rows(conn, from, to, address)))
    }

    /// Move a note's rows and then let `rename` move the file (Plan 17): the
    /// rows migrate and **commit first**, then the file renames; a failed
    /// rename compensates with a reverse row-move. DB-first ordering is what
    /// makes a watcher echo benign: `remove(from)` finds no rows and
    /// `upsert(to)` re-applies an identical projection over the moved one.
    ///
    /// The rename must never run *inside* the transaction: a commit failing
    /// after the file moved would roll the rows back while the disk kept the
    /// new path. The caller gates this on the **graph** generation and holds
    /// the graph lock; here the only check is that this index was opened for
    /// `root`, so a move can never land in another graph's index.
    pub fn move_note(
        &self,
        root: &Path,
        request: &NoteMoveRequest,
        rename: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        let mut writer = self.lock_writer()?;
        if writer.root.as_deref() != Some(root) {
            return Err(AppError::io(
                "the index is open for another graph; dropping the move",
            ));
        }
        let conn = writer.conn.as_mut().ok_or_else(AppError::no_graph)?;
        move_rows(conn, &request.from, &request.to, &request.to_address)?;
        if let Err(err) = rename() {
            // Compensate: the disk refused, so the rows go back. Best-effort:
            // a failed compensation must surface the *original* error, and
            // the reconcile heals any residue by id.
            if let Err(comp) = move_rows(conn, &request.to, &request.from, &request.from_address) {
                tracing::error!(
                    ?comp,
                    "rename compensation failed; reconcile will heal by id"
                );
            }
            return Err(err);
        }
        Ok(())
    }

    /// Compare the listed notes against the stored rows and return only what
    /// needs work. `files` is the walk of [`root_for_generation`]'s root, done
    /// by the caller **without** the index lock held; the generation is
    /// checked again here, so a graph switch mid-walk yields the empty scan.
    ///
    /// [`root_for_generation`]: IndexSession::root_for_generation
    pub fn reconcile_scan(
        &self,
        generation: u64,
        files: &[FileMeta],
        now_ms: u64,
    ) -> AppResult<ReconcileScan> {
        let writer = self.lock_writer()?;
        if writer.generation != generation {
            return Ok(ReconcileScan::empty());
        }
        let conn = writer.conn.as_ref().ok_or_else(AppError::no_graph)?;
        scan::scan_reconcile(conn, files, now_ms)
    }

    /// Re-stamp stored mtimes for notes whose content already matches disk
    /// (the reconcile's hash-match skip). One transaction for the batch; a
    /// path whose row vanished in between updates nothing.
    pub fn touch(&self, generation: u64, entries: &[IndexTouch]) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| {
            let tx = conn.transaction()?;
            for entry in entries {
                write::touch_note(&tx, &entry.path, entry.mtime)?;
            }
            tx.commit()?;
            Ok(())
        }))
    }

    /// Upsert one `index_meta` key. The table is bookkeeping the TS policy
    /// layer owns, and [`clear`] deliberately preserves it, so a marker can
    /// outlive the rows it describes.
    ///
    /// [`clear`]: IndexSession::clear
    pub fn set_meta(&self, generation: u64, key: &str, value: &str) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| {
            conn.prepare_cached(
                "INSERT INTO index_meta(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?
            .execute(params![key, value])?;
            Ok(())
        }))
    }

    /// Wipe all derived tables (the TS layer then re-applies every note). The
    /// `chat_*` tables are deliberately untouched: chat history is durable,
    /// not a rebuildable projection.
    pub fn clear(&self, generation: u64) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| write::clear_index(conn)))
    }

    /// Upsert one chat message and its conversation row in a single
    /// transaction. Called at send time with the user half and again at settle
    /// with the full record, so a crash mid-stream keeps the user message.
    pub fn save_chat_message(
        &self,
        generation: u64,
        conversation: &ChatConversation,
        message: &ChatMessageRow,
    ) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| {
            let tx = conn.transaction()?;
            chat_write::save_message(&tx, conversation, message)?;
            tx.commit()?;
            Ok(())
        }))
    }

    /// Delete a conversation and (via cascade) its messages.
    pub fn delete_chat_conversation(&self, generation: u64, id: &str) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| chat_write::delete_conversation(conn, id)))
    }

    /// Replace a note's embedding chunk set (diff applied in one transaction).
    /// Unchanged chunks keep their vectors.
    pub fn apply_embeddings(
        &self,
        generation: u64,
        path: &str,
        chunks: &[EmbeddedChunk],
    ) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| {
            let tx = conn.transaction()?;
            embed_write::apply_chunks(&tx, path, chunks)?;
            tx.commit()?;
            Ok(())
        }))
    }

    /// Drop a deleted note's chunks and vectors.
    pub fn remove_embeddings(&self, generation: u64, path: &str) -> AppResult<Applied> {
        Self::applied(self.write(generation, |conn| {
            // Two DELETEs (vectors, then rows): atomic, mirroring apply.
            let tx = conn.transaction()?;
            embed_write::remove_chunks(&tx, path)?;
            tx.commit()?;
            Ok(())
        }))
    }

    /// Execute a read query and return its rows. `requested` is the reader
    /// generation the caller saw when the query was issued: a session rebound
    /// in between must error rather than answer with another graph's rows,
    /// because the frontend caches results under root-scoped keys.
    pub fn query(
        &self,
        requested: u64,
        sql: &str,
        params: &[Value],
    ) -> AppResult<Vec<Map<String, Value>>> {
        let reader = self.lock_reader()?;
        if reader.generation != requested {
            return Err(AppError::io("index reopened during query"));
        }
        if reader.on_writer {
            // Single-connection hosts: release the reader lock first, because
            // the lock order is writer then reader.
            drop(reader);
            let writer = self.lock_writer()?;
            if writer.generation != requested {
                return Err(AppError::io("index reopened during query"));
            }
            let conn = writer.conn.as_ref().ok_or_else(AppError::no_graph)?;
            return query::run_query(conn, sql, params);
        }
        let conn = reader.conn.as_ref().ok_or_else(AppError::no_graph)?;
        query::run_query(conn, sql, params)
    }
}

/// One committed row-move transaction (the rename pipeline's halves).
fn move_rows(
    conn: &mut Connection,
    from: &str,
    to: &str,
    address: &MovedNoteAddress,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    // Child tables FK `notes(path)`; deferring lets the parent key move first
    // and the constraint re-check at commit, when the children have followed.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    write::move_note(&tx, from, to, address)?;
    tx.commit()?;
    Ok(())
}
