//! SQLite index layer (Plan 04).
//!
//! The graph's rebuildable projection lives at `<graph>/.reflect/index.sqlite`,
//! backed by the bundled SQLite (FTS5 compiled in) with sqlite-vec registered for
//! Plan 09. Parsing/extraction happens in TS (`@reflect/core`, Plan 03); this
//! module owns the schema, migrations, and all writes (one transaction per
//! batch), plus a read-only `db_query` bridge that executes the SQL the frontend
//! builds with Kysely. The DB is a cache: deleting it loses nothing durable.

use std::ffi::{c_char, c_int};
use std::path::Path;
use std::sync::{LazyLock, Mutex, OnceLock};

use rusqlite::ffi::{sqlite3, sqlite3_api_routines};
use rusqlite::{params, params_from_iter, Connection};
use rusqlite_migration::{Migrations, M};
use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

/// Ordered schema migrations, loaded from `migrations/*.sql`. `rusqlite_migration`
/// tracks the applied version in SQLite's `user_version` pragma. Append a new
/// `M::up(include_str!(...))` (never edit a shipped one) as later plans add
/// tables (embeddings in 09, captures in 11, sync state in 12).
static MIGRATIONS: LazyLock<Migrations<'static>> =
    LazyLock::new(|| Migrations::new(vec![M::up(include_str!("../migrations/0001_initial.sql"))]));

/// Result of the one-time sqlite-vec registration; the error message is cached so
/// every caller can surface it as an `AppError` rather than panicking.
static VEC_INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// The SQLite auto-extension entry-point signature. sqlite-vec and rusqlite each
/// link their own copy of the C types, so we transmute `sqlite3_vec_init` into
/// rusqlite's matching function-pointer type.
type AutoExtensionFn =
    unsafe extern "C" fn(*mut sqlite3, *mut *mut c_char, *const sqlite3_api_routines) -> c_int;

/// Registers the sqlite-vec extension once per process, so every connection
/// opened afterwards exposes the `vec0` virtual table and `vec_*` functions.
/// Returns the cached registration result so a failure surfaces as an `AppError`
/// (e.g. from `index_open`) instead of panicking and crashing the backend.
fn register_sqlite_vec() -> AppResult<()> {
    let result = VEC_INIT.get_or_init(|| {
        // SAFETY: registering a statically-linked SQLite extension entry point
        // before opening connections — the documented sqlite-vec pattern.
        let rc = unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                *const (),
                AutoExtensionFn,
            >(
                sqlite_vec::sqlite3_vec_init as *const ()
            )))
        };
        if rc == rusqlite::ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(format!(
                "failed to register the sqlite-vec auto-extension (code {rc})"
            ))
        }
    });
    result.clone().map_err(AppError::io)
}

/// Opens an in-memory connection with sqlite-vec available (used by tests).
#[allow(dead_code)]
pub fn open_in_memory() -> AppResult<Connection> {
    register_sqlite_vec()?;
    Ok(Connection::open_in_memory()?)
}

/// The open index connection for the active graph (`None` until `index_open`).
#[derive(Default)]
pub struct IndexState(pub Mutex<Option<Connection>>);

/// Bring the connection up to the latest schema version (no-op if current).
fn migrate(conn: &mut Connection) -> AppResult<()> {
    MIGRATIONS
        .to_latest(conn)
        .map_err(|err| AppError::io(format!("migration failed: {err}")))
}

/// Open (creating if needed) and migrate `<root>/.reflect/index.sqlite`.
fn open_index_at(root: &Path) -> AppResult<Connection> {
    register_sqlite_vec()?;
    let dir = root.join(".reflect");
    std::fs::create_dir_all(&dir)?;
    let mut conn = Connection::open(dir.join("index.sqlite"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    migrate(&mut conn)?;
    Ok(conn)
}

// ---- query bridge ----------------------------------------------------------

fn json_to_sql(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| n.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        Value::String(s) => Sql::Text(s.clone()),
        // arrays/objects arrive only from the `json()` helper → store as JSON text
        other => Sql::Text(other.to_string()),
    }
}

fn column_to_json(row: &rusqlite::Row, index: usize) -> AppResult<Value> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(index)? {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::from(n),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::from(bytes.to_vec()),
    })
}

/// Execute a read query the frontend compiled with Kysely; rows as JSON objects.
fn run_query(conn: &Connection, sql: &str, params: &[Value]) -> AppResult<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare(sql)?;
    // `db_query` is a read-only bridge — writes go through the `index_*` commands.
    // Reject any mutating statement so a compromised/buggy caller can't write.
    if !stmt.readonly() {
        return Err(AppError::io("db_query only executes read-only statements"));
    }
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let bound: Vec<rusqlite::types::Value> = params.iter().map(json_to_sql).collect();
    let mut rows = stmt.query(params_from_iter(bound))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut object = Map::with_capacity(columns.len());
        for (index, name) in columns.iter().enumerate() {
            object.insert(name.clone(), column_to_json(row, index)?);
        }
        out.push(object);
    }
    Ok(out)
}

// ---- write path ------------------------------------------------------------

/// A note's extracted projection, built in TS (Plan 03) and applied as one row-set.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedNote {
    path: String,
    id: Option<String>,
    title: String,
    title_key: String,
    daily_date: Option<String>,
    is_private: bool,
    file_hash: String,
    mtime: i64,
    text: String,
    links: Vec<IndexedLink>,
    tags: Vec<String>,
    aliases: Vec<IndexedAlias>,
    assets: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexedLink {
    kind: String,
    target_raw: String,
    target_key: String,
    alias: Option<String>,
    pos_from: i64,
    pos_to: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexedAlias {
    alias: String,
    alias_key: String,
}

/// Replace all derived rows for `note.path` and upsert its `notes` row. Caller
/// wraps this in a transaction.
fn apply_note(conn: &Connection, note: &IndexedNote) -> AppResult<()> {
    conn.execute(
        "DELETE FROM links WHERE source_path = ?1",
        params![note.path],
    )?;
    conn.execute("DELETE FROM tags WHERE note_path = ?1", params![note.path])?;
    conn.execute(
        "DELETE FROM aliases WHERE note_path = ?1",
        params![note.path],
    )?;
    conn.execute(
        "DELETE FROM assets WHERE note_path = ?1",
        params![note.path],
    )?;
    conn.execute(
        "DELETE FROM note_text WHERE note_path = ?1",
        params![note.path],
    )?;
    conn.execute("DELETE FROM search_fts WHERE path = ?1", params![note.path])?;

    conn.execute(
        "INSERT INTO notes(path, id, title, title_key, daily_date, is_private, file_hash, mtime, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(path) DO UPDATE SET
           id = ?2, title = ?3, title_key = ?4, daily_date = ?5,
           is_private = ?6, file_hash = ?7, mtime = ?8, updated_at = ?8",
        params![
            note.path,
            note.id,
            note.title,
            note.title_key,
            note.daily_date,
            i64::from(note.is_private),
            note.file_hash,
            note.mtime,
        ],
    )?;
    conn.execute(
        "INSERT INTO note_text(note_path, text) VALUES(?1, ?2)",
        params![note.path, note.text],
    )?;
    for link in &note.links {
        conn.execute(
            "INSERT INTO links(source_path, kind, target_raw, target_key, alias, pos_from, pos_to)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                note.path,
                link.kind,
                link.target_raw,
                link.target_key,
                link.alias,
                link.pos_from,
                link.pos_to
            ],
        )?;
    }
    for tag in &note.tags {
        conn.execute(
            "INSERT INTO tags(note_path, tag) VALUES(?1, ?2)",
            params![note.path, tag],
        )?;
    }
    for alias in &note.aliases {
        conn.execute(
            "INSERT INTO aliases(note_path, alias, alias_key) VALUES(?1, ?2, ?3)",
            params![note.path, alias.alias, alias.alias_key],
        )?;
    }
    for asset in &note.assets {
        conn.execute(
            "INSERT INTO assets(note_path, asset_path) VALUES(?1, ?2)",
            params![note.path, asset],
        )?;
    }
    conn.execute(
        "INSERT INTO search_fts(path, title, body) VALUES(?1, ?2, ?3)",
        params![note.path, note.title, note.text],
    )?;
    Ok(())
}

/// Wipe every derived table (for a full rebuild driven by TS).
fn clear_index(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "DELETE FROM notes; DELETE FROM note_text; DELETE FROM links; DELETE FROM tags;
         DELETE FROM aliases; DELETE FROM assets; DELETE FROM search_fts;",
    )?;
    Ok(())
}

fn remove_note(conn: &Connection, path: &str) -> AppResult<()> {
    // notes cascades to child tables; search_fts is standalone.
    conn.execute("DELETE FROM notes WHERE path = ?1", params![path])?;
    conn.execute("DELETE FROM search_fts WHERE path = ?1", params![path])?;
    Ok(())
}

fn lock_index<'a>(
    index: &'a State<IndexState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<Connection>>> {
    index
        .0
        .lock()
        .map_err(|_| AppError::io("index state lock poisoned"))
}

// ---- commands --------------------------------------------------------------

/// Open + migrate the index for the active graph (reads the root from state).
#[tauri::command]
pub fn index_open(graph: State<GraphState>, index: State<IndexState>) -> AppResult<()> {
    let root = graph
        .0
        .lock()
        .map_err(|_| AppError::io("graph state lock poisoned"))?
        .clone()
        .ok_or_else(AppError::no_graph)?;
    // Drop the previous graph's connection first, so a failed open can't leave a
    // stale connection that later reads would hit (wrong graph's data).
    *lock_index(&index)? = None;
    let conn = open_index_at(&root)?;
    *lock_index(&index)? = Some(conn);
    Ok(())
}

/// Apply one note's extracted projection in a single transaction.
#[tauri::command]
pub fn index_apply(note: IndexedNote, index: State<IndexState>) -> AppResult<()> {
    let mut guard = lock_index(&index)?;
    let conn = guard.as_mut().ok_or_else(AppError::no_graph)?;
    let tx = conn.transaction()?;
    apply_note(&tx, &note)?;
    tx.commit()?;
    Ok(())
}

/// Remove a note (e.g. deleted on disk) from the index.
#[tauri::command]
pub fn index_remove(path: String, index: State<IndexState>) -> AppResult<()> {
    let guard = lock_index(&index)?;
    let conn = guard.as_ref().ok_or_else(AppError::no_graph)?;
    remove_note(conn, &path)
}

/// Wipe all derived tables (the TS layer then re-applies every note).
#[tauri::command]
pub fn index_clear(index: State<IndexState>) -> AppResult<()> {
    let guard = lock_index(&index)?;
    let conn = guard.as_ref().ok_or_else(AppError::no_graph)?;
    clear_index(conn)
}

/// Execute a read query (compiled by Kysely on the frontend) and return rows.
#[tauri::command]
pub fn db_query(
    sql: String,
    params: Vec<Value>,
    index: State<IndexState>,
) -> AppResult<Vec<Map<String, Value>>> {
    let guard = lock_index(&index)?;
    let conn = guard.as_ref().ok_or_else(AppError::no_graph)?;
    run_query(conn, &sql, &params)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys=ON;").expect("fk");
        migrate(&mut conn).expect("migrate");
        conn
    }

    fn note(path: &str, title: &str, links: Vec<IndexedLink>) -> IndexedNote {
        IndexedNote {
            path: path.to_string(),
            id: None,
            title: title.to_string(),
            title_key: title.to_lowercase(),
            daily_date: None,
            is_private: false,
            file_hash: "h".to_string(),
            mtime: 0,
            text: format!("{title} body"),
            links,
            tags: vec![],
            aliases: vec![],
            assets: vec![],
        }
    }

    fn wiki(target: &str) -> IndexedLink {
        IndexedLink {
            kind: "wiki".to_string(),
            target_raw: target.to_string(),
            target_key: target.to_lowercase(),
            alias: None,
            pos_from: 0,
            pos_to: 0,
        }
    }

    #[test]
    fn migrations_are_valid_and_idempotent() {
        // Guards every migration's SQL (rusqlite_migration validates the set).
        MIGRATIONS.validate().expect("migration set is valid");
        let mut conn = migrated();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1); // one applied migration
        migrate(&mut conn).expect("re-running to_latest is a no-op");
    }

    #[test]
    fn backlinks_resolve_by_title_at_query_time() {
        let conn = migrated();
        // Source links to "Target" before the target note even exists.
        apply_note(&conn, &note("notes/a.md", "A", vec![wiki("Target")])).unwrap();
        let none = run_query(
            &conn,
            "SELECT source_path FROM backlinks WHERE target_path = ?1",
            &[Value::from("notes/target.md")],
        )
        .unwrap();
        assert!(none.is_empty());

        // Creating the target immediately resolves the inbound link (join, no reindex).
        apply_note(&conn, &note("notes/target.md", "Target", vec![])).unwrap();
        let rows = run_query(
            &conn,
            "SELECT source_path FROM backlinks WHERE target_path = ?1",
            &[Value::from("notes/target.md")],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["source_path"], Value::from("notes/a.md"));
    }

    #[test]
    fn reapplying_a_note_replaces_its_rows() {
        let conn = migrated();
        apply_note(&conn, &note("notes/a.md", "A", vec![wiki("X"), wiki("Y")])).unwrap();
        apply_note(&conn, &note("notes/a.md", "A", vec![wiki("Z")])).unwrap();
        let rows = run_query(&conn, "SELECT target_key FROM links", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["target_key"], Value::from("z"));
    }

    #[test]
    fn fts_matches_indexed_body() {
        let conn = migrated();
        apply_note(&conn, &note("notes/a.md", "Quick", vec![])).unwrap();
        let rows = run_query(
            &conn,
            "SELECT path FROM search_fts WHERE search_fts MATCH ?1",
            &[Value::from("quick")],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn db_query_rejects_mutating_statements() {
        let conn = migrated();
        assert!(run_query(&conn, "DELETE FROM notes", &[]).is_err());
        assert!(run_query(&conn, "SELECT count(*) FROM notes", &[]).is_ok());
    }

    #[test]
    fn clear_empties_derived_tables() {
        let conn = migrated();
        apply_note(&conn, &note("notes/a.md", "A", vec![wiki("X")])).unwrap();
        clear_index(&conn).unwrap();
        let rows = run_query(&conn, "SELECT count(*) AS n FROM notes", &[]).unwrap();
        assert_eq!(rows[0]["n"], Value::from(0));
    }

    #[test]
    fn fts5_is_compiled_in() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE fts USING fts5(body);
             INSERT INTO fts(body) VALUES ('the quick brown fox');",
        )
        .expect("fts5 create/insert");
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM fts WHERE fts MATCH 'quick'",
                [],
                |row| row.get(0),
            )
            .expect("fts5 match");
        assert_eq!(hits, 1);
    }

    #[test]
    fn sqlite_vec_loads_and_runs_knn() {
        let conn = open_in_memory().expect("open with vec");
        let version: String = conn
            .query_row("SELECT vec_version()", [], |row| row.get(0))
            .expect("vec_version");
        assert!(!version.is_empty());

        conn.execute_batch(
            "CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[4]);
             INSERT INTO vec_items(rowid, embedding) VALUES
               (1, '[1, 2, 3, 4]'),
               (2, '[9, 9, 9, 9]');",
        )
        .expect("vec0 create/insert");

        let nearest: i64 = conn
            .query_row(
                "SELECT rowid FROM vec_items \
                 WHERE embedding MATCH '[1, 2, 3, 4]' ORDER BY distance LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("vec0 knn");
        assert_eq!(nearest, 1);
    }
}
