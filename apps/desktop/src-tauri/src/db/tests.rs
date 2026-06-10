//! Cross-module index tests: most exercise the write path and the query bridge
//! together against a migrated in-memory database, the same shape the commands
//! compose at runtime.

use rusqlite::Connection;
use serde_json::Value;

use super::embed_write::{apply_chunks, remove_chunks, EmbeddedChunk};
use super::migrations::{migrate, migrate_to, open_in_memory, open_index_at, validate_migrations};
use super::query::run_query;
use super::write::{apply_note, clear_index, IndexedLink, IndexedNote, IndexedTag};

fn migrated() -> Connection {
    // Registers sqlite-vec before migrating — the 0002 migration creates a
    // vec0 table, so a raw rusqlite open would fail with "no such module".
    let mut conn = open_in_memory().expect("open");
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
        is_pinned: false,
        pinned_order: None,
        file_hash: "h".to_string(),
        mtime: 0,
        text: format!("{title} body"),
        preview: "body".to_string(),
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
    validate_migrations().expect("migration set is valid");
    let mut conn = migrated();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 5); // applied migrations (0001 through 0005)
    migrate(&mut conn).expect("re-running to_latest is a no-op");
}

#[test]
fn preview_and_tag_keys_round_trip() {
    let conn = migrated();
    let mut tagged = note("notes/a.md", "A", vec![]);
    tagged.preview = "first body line".to_string();
    tagged.tags = vec![IndexedTag {
        tag: "Café".to_string(),
        tag_key: "café".to_string(),
    }];
    apply_note(&conn, &tagged).unwrap();

    let notes = run_query(&conn, "SELECT preview FROM notes", &[]).unwrap();
    assert_eq!(notes[0]["preview"], Value::from("first body line"));

    // Display casing and the TS-folded key are stored side by side — matching
    // happens on tag_key (SQLite's lower() couldn't fold the É).
    let tags = run_query(&conn, "SELECT tag, tag_key FROM tags", &[]).unwrap();
    assert_eq!(tags[0]["tag"], Value::from("Café"));
    assert_eq!(tags[0]["tag_key"], Value::from("café"));
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
fn pinned_migration_drops_stale_note_rows_for_reindex() {
    // Rows indexed before 0003 would keep is_pinned=0 even where the file
    // already says `pinned: true` (the open-time reconcile hash-skips
    // unchanged files) — the migration wipes the projection so the next open
    // re-indexes everything with the new column populated.
    let mut conn = open_in_memory().expect("open");
    migrate_to(&mut conn, 2).expect("migrate to v2");
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, file_hash) VALUES('notes/a.md', 'A', 'a', 'h');
         INSERT INTO tags(note_path, tag) VALUES('notes/a.md', 'x');
         INSERT INTO search_fts(path, title, body) VALUES('notes/a.md', 'A', 'A body');
         INSERT INTO index_meta(key, value) VALUES('k', 'v');",
    )
    .expect("stage v2 rows");

    migrate(&mut conn).expect("migrate to latest");
    for table in ["notes", "tags", "search_fts"] {
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table} should be wiped for the re-index");
    }
    // Bookkeeping outlives the wipe (same contract as index_clear).
    let meta: i64 = conn
        .query_row("SELECT count(*) FROM index_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(meta, 1);
}

#[test]
fn pinned_flag_and_order_round_trip_into_the_notes_row() {
    let conn = migrated();
    let mut pinned = note("notes/p.md", "P", vec![]);
    pinned.is_pinned = true;
    pinned.pinned_order = Some(1.5);
    apply_note(&conn, &pinned).unwrap();
    apply_note(&conn, &note("notes/q.md", "Q", vec![])).unwrap();
    let rows = run_query(
        &conn,
        "SELECT path, pinned_order FROM notes WHERE is_pinned = 1",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["path"], Value::from("notes/p.md"));
    assert_eq!(rows[0]["pinned_order"], Value::from(1.5));
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
fn clear_cascades_to_child_tables() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("X")])).unwrap();
    clear_index(&conn).unwrap();
    // Deleting notes cascades to children; search_fts is cleared explicitly.
    for table in [
        "notes",
        "note_text",
        "links",
        "tags",
        "aliases",
        "assets",
        "search_fts",
    ] {
        let rows = run_query(&conn, &format!("SELECT count(*) AS n FROM {table}"), &[]).unwrap();
        assert_eq!(rows[0]["n"], Value::from(0), "{table} should be empty");
    }
}

#[test]
fn reapplying_a_note_cascades_away_stale_children() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![wiki("X"), wiki("Y")])).unwrap();
    // Re-applying clears the note (cascade) before reinserting, so the old
    // tags/links don't linger even though apply_note lists no explicit deletes.
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    let rows = run_query(&conn, "SELECT count(*) AS n FROM links", &[]).unwrap();
    assert_eq!(rows[0]["n"], Value::from(0));
}

#[test]
fn link_kind_check_rejects_unknown_kinds() {
    let conn = migrated();
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    let bogus = conn.execute(
        "INSERT INTO links(source_path, kind, target_raw, target_key, pos_from, pos_to)
         VALUES('notes/a.md', 'bogus', 'X', 'x', 0, 0)",
        [],
    );
    assert!(
        bogus.is_err(),
        "CHECK should reject kinds other than wiki/md"
    );
}

#[test]
fn open_index_at_creates_migrates_and_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();

    let conn = open_index_at(root).expect("first open");
    assert!(root.join(".reflect/index.sqlite").exists());
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 5);
    let journal: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal, "wal");
    drop(conn);

    // Reopening an existing index is a no-op migration and preserves data.
    let conn = open_index_at(root).expect("first open");
    apply_note(&conn, &note("notes/a.md", "A", vec![])).unwrap();
    drop(conn);
    let conn = open_index_at(root).expect("reopen");
    let rows = run_query(&conn, "SELECT count(*) AS n FROM notes", &[]).unwrap();
    assert_eq!(rows[0]["n"], Value::from(1));
}

/// Command-level integration: the generation gate that every TS write relies on.
/// A write carrying a stale generation (issued before the index was reopened)
/// must silently no-op rather than mutate the newly-opened index.
#[test]
fn stale_generation_writes_are_dropped_end_to_end() {
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    app.manage(crate::fs::GraphState::default());
    app.manage(super::IndexState::default());

    let graph_dir = tempfile::tempdir().expect("tempdir");
    {
        let state: tauri::State<crate::fs::GraphState> = app.state();
        let mut inner = state.0.lock().unwrap();
        inner.generation = 1;
        inner.root = Some(graph_dir.path().to_path_buf());
    }

    let count = |label: &str| -> Value {
        let rows = super::db_query(
            "SELECT count(*) AS n FROM notes".to_string(),
            vec![],
            app.state(),
        )
        .unwrap_or_else(|err| panic!("{label}: {err:?}"));
        rows[0]["n"].clone()
    };

    let stale = super::index_open(app.state(), app.state()).expect("first open");
    super::index_apply(note("notes/a.md", "A", vec![]), stale, app.state()).expect("apply");
    assert_eq!(count("after first apply"), Value::from(1));

    // Reopening (graph switch / reload) bumps the generation; the old one is stale.
    let fresh = super::index_open(app.state(), app.state()).expect("reopen");
    assert_ne!(stale, fresh);

    super::index_apply(note("notes/b.md", "B", vec![]), stale, app.state())
        .expect("stale apply returns Ok");
    assert_eq!(count("after stale apply"), Value::from(1)); // dropped, not applied

    super::index_remove("notes/a.md".to_string(), stale, app.state())
        .expect("stale remove returns Ok");
    assert_eq!(count("after stale remove"), Value::from(1)); // also dropped

    super::index_apply(note("notes/b.md", "B", vec![]), fresh, app.state()).expect("fresh apply");
    assert_eq!(count("after fresh apply"), Value::from(2));

    // index_meta_set rides the same gate: stale stamps vanish, fresh ones land
    // (and upsert — the projection-version stamp is written after every rebuild).
    let meta = |label: &str| -> Vec<serde_json::Map<String, Value>> {
        super::db_query(
            "SELECT value FROM index_meta WHERE key = 'k'".to_string(),
            vec![],
            app.state(),
        )
        .unwrap_or_else(|err| panic!("{label}: {err:?}"))
    };
    super::index_meta_set("k".to_string(), "stale".to_string(), stale, app.state())
        .expect("stale meta set returns Ok");
    assert!(meta("after stale meta set").is_empty());
    super::index_meta_set("k".to_string(), "v1".to_string(), fresh, app.state())
        .expect("fresh meta set");
    super::index_meta_set("k".to_string(), "v2".to_string(), fresh, app.state())
        .expect("meta upsert");
    assert_eq!(meta("after meta upsert")[0]["value"], Value::from("v2"));
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

// ---- embeddings (Plan 09) ---------------------------------------------------

fn chunk(hash: &str, vector: Option<Vec<f32>>) -> EmbeddedChunk {
    EmbeddedChunk {
        heading: None,
        pos_from: 0,
        pos_to: 10,
        text: format!("text {hash}"),
        content_hash: hash.to_string(),
        model_id: "all-MiniLM-L6-v2".to_string(),
        vector,
    }
}

fn vec384(fill: f32) -> Vec<f32> {
    vec![fill; 384]
}

/// Chunks only exist for indexed notes (apply_chunks guards on the row).
fn index_note(conn: &Connection, path: &str) {
    apply_note(conn, &note(path, "T", vec![])).unwrap();
}

fn chunk_rows(conn: &Connection) -> Vec<(String, String)> {
    conn.prepare("SELECT note_path, content_hash FROM embedding_chunks ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn vector_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM embedding_vectors", [], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn apply_chunks_inserts_new_and_drops_stale_with_their_vectors() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(
        &conn,
        "notes/a.md",
        &[
            chunk("h1", Some(vec384(0.1))),
            chunk("h2", Some(vec384(0.2))),
        ],
    )
    .unwrap();
    assert_eq!(vector_count(&conn), 2);

    // h2 survives unembedded (hash-skip); h3 is new; h1 is gone.
    apply_chunks(
        &conn,
        "notes/a.md",
        &[chunk("h2", None), chunk("h3", Some(vec384(0.3)))],
    )
    .unwrap();
    assert_eq!(
        chunk_rows(&conn),
        vec![
            ("notes/a.md".to_string(), "h2".to_string()),
            ("notes/a.md".to_string(), "h3".to_string()),
        ]
    );
    assert_eq!(vector_count(&conn), 2);
}

#[test]
fn unchanged_chunks_keep_vectors_but_refresh_positions() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("h1", Some(vec384(0.5)))]).unwrap();
    let mut moved = chunk("h1", None);
    moved.pos_from = 100;
    moved.pos_to = 140;
    apply_chunks(&conn, "notes/a.md", &[moved]).unwrap();
    let (from, to): (i64, i64) = conn
        .query_row(
            "SELECT pos_from, pos_to FROM embedding_chunks WHERE content_hash = 'h1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((from, to), (100, 140));
    assert_eq!(vector_count(&conn), 1);
}

#[test]
fn an_unchanged_chunk_without_a_stored_row_is_a_loud_error() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    let result = apply_chunks(&conn, "notes/a.md", &[chunk("missing", None)]);
    assert!(result.is_err());
}

#[test]
fn remove_chunks_drops_rows_and_vectors_for_one_note_only() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    index_note(&conn, "notes/b.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.1)))]).unwrap();
    apply_chunks(&conn, "notes/b.md", &[chunk("b1", Some(vec384(0.2)))]).unwrap();
    remove_chunks(&conn, "notes/a.md").unwrap();
    assert_eq!(
        chunk_rows(&conn),
        vec![("notes/b.md".to_string(), "b1".to_string())]
    );
    assert_eq!(vector_count(&conn), 1);
}

#[test]
fn clear_index_wipes_embeddings_too() {
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.1)))]).unwrap();
    clear_index(&conn).unwrap();
    assert_eq!(chunk_rows(&conn), vec![]);
    assert_eq!(vector_count(&conn), 0);
}

#[test]
fn knn_query_returns_nearest_chunk_first() {
    let conn = migrated();
    index_note(&conn, "notes/near.md");
    index_note(&conn, "notes/far.md");
    let mut near = vec384(0.0);
    near[0] = 1.0;
    let mut far = vec384(0.0);
    far[1] = 1.0;
    apply_chunks(&conn, "notes/near.md", &[chunk("n", Some(near))]).unwrap();
    apply_chunks(&conn, "notes/far.md", &[chunk("f", Some(far))]).unwrap();

    let mut probe = vec![0.0f32; 384];
    probe[0] = 0.9;
    let probe_json = format!(
        "[{}]",
        probe
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    // The same shape the frontend uses through read-only db_query.
    let rows = run_query(
        &conn,
        "SELECT c.note_path FROM embedding_vectors v
         JOIN embedding_chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ?1 AND k = 2
         ORDER BY v.distance",
        &[Value::String(probe_json)],
    )
    .unwrap();
    let first = rows[0].get("note_path").unwrap().as_str().unwrap();
    assert_eq!(first, "notes/near.md");
}

#[test]
fn reindexing_a_note_keeps_its_chunks_but_true_deletion_drops_them() {
    let mut conn = migrated();
    apply_note(&conn, &note("notes/a.md", "Alpha", vec![])).unwrap();
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.1)))]).unwrap();

    // Upsert path: apply_note re-creates the note row — chunks must survive
    // (the hash-skip depends on it).
    apply_note(&conn, &note("notes/a.md", "Alpha edited", vec![])).unwrap();
    assert_eq!(chunk_rows(&conn).len(), 1);
    assert_eq!(vector_count(&conn), 1);

    // Genuine deletion (the index_remove command shape): everything goes.
    let tx = conn.transaction().unwrap();
    super::write::remove_note(&tx, "notes/a.md").unwrap();
    super::embed_write::remove_chunks(&tx, "notes/a.md").unwrap();
    tx.commit().unwrap();
    assert_eq!(chunk_rows(&conn), vec![]);
    assert_eq!(vector_count(&conn), 0);
}

#[test]
fn embedding_vectors_use_cosine_distance() {
    // A probe pointing the same direction as a stored vector but at half its
    // magnitude: cosine distance 0, L2 distance 0.5 — this test discriminates
    // the metric (retrieve.ts thresholds raw distances as cosine).
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    let mut stored = vec384(0.0);
    stored[0] = 1.0;
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(stored))]).unwrap();

    let mut probe = vec![0.0f32; 384];
    probe[0] = 0.5;
    let probe_json = format!(
        "[{}]",
        probe
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    let rows = run_query(
        &conn,
        "SELECT v.distance FROM embedding_vectors v
         WHERE v.embedding MATCH ?1 AND k = 1 ORDER BY v.distance",
        &[Value::String(probe_json)],
    )
    .unwrap();
    let distance = rows[0].get("distance").unwrap().as_f64().unwrap();
    assert!(
        distance.abs() < 1e-6,
        "expected cosine distance 0, got {distance}"
    );
}

#[test]
fn cosine_migration_preserves_stored_vectors() {
    // Stage a vector on the pre-cosine schema (0002), then run 0003: the
    // vector must survive the table rebuild byte-for-byte (no re-embedding),
    // matching itself at cosine distance 0.
    let mut conn = open_in_memory().expect("open");
    migrate_to(&mut conn, 2).expect("migrate to 0002");
    // Stage a note with raw SQL — apply_note writes is_pinned/pinned_order
    // which don't exist until 0004, so we insert the v2-era columns directly.
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, file_hash, mtime, updated_at) \
         VALUES('notes/a.md', 'A', 'a', 'h', 0, 0);",
    )
    .expect("stage v2 note");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.25)))]).unwrap();
    assert_eq!(vector_count(&conn), 1);

    migrate(&mut conn).expect("migrate to latest");
    assert_eq!(vector_count(&conn), 1);

    let vec_json = run_query(
        &conn,
        "SELECT vec_to_json(v.embedding) AS vec FROM embedding_vectors v",
        &[],
    )
    .unwrap()[0]
        .get("vec")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    let rows = run_query(
        &conn,
        "SELECT c.note_path, v.distance FROM embedding_vectors v
         JOIN embedding_chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ?1 AND k = 1 ORDER BY v.distance",
        &[Value::String(vec_json)],
    )
    .unwrap();
    assert_eq!(
        rows[0].get("note_path").unwrap().as_str().unwrap(),
        "notes/a.md"
    );
    let distance = rows[0].get("distance").unwrap().as_f64().unwrap();
    assert!(
        distance.abs() < 1e-6,
        "expected cosine distance 0, got {distance}"
    );
}

#[test]
fn stored_vectors_round_trip_through_vec_to_json() {
    // relatedNotes (TS) seeds KNN with `vec_to_json(embedding)` via db_query;
    // pin the function name + shape against the real extension.
    let conn = migrated();
    index_note(&conn, "notes/a.md");
    apply_chunks(&conn, "notes/a.md", &[chunk("a1", Some(vec384(0.25)))]).unwrap();
    let rows = run_query(
        &conn,
        "SELECT vec_to_json(v.embedding) AS vec
         FROM embedding_chunks c JOIN embedding_vectors v ON v.rowid = c.id
         WHERE c.note_path = ?1 ORDER BY c.pos_from LIMIT 1",
        &[Value::String("notes/a.md".to_string())],
    )
    .unwrap();
    let vec = rows[0].get("vec").unwrap().as_str().unwrap();
    assert!(vec.starts_with('['));
    // And the JSON form is MATCH-able right back (the second relatedNotes query).
    let knn = run_query(
        &conn,
        "SELECT c.note_path FROM embedding_vectors v
         JOIN embedding_chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ?1 AND k = 1 ORDER BY v.distance",
        &[Value::String(vec.to_string())],
    )
    .unwrap();
    assert_eq!(
        knn[0].get("note_path").unwrap().as_str().unwrap(),
        "notes/a.md"
    );
}

#[test]
fn apply_chunks_for_an_unindexed_path_is_a_cleaning_no_op() {
    // The embed pipeline can race index_remove: a late embed_apply for a
    // deleted note must not reinsert vectors for a dead path.
    let conn = migrated();
    let result = apply_chunks(&conn, "notes/gone.md", &[chunk("g1", Some(vec384(0.1)))]);
    assert!(result.is_ok());
    assert_eq!(chunk_rows(&conn), vec![]);
    assert_eq!(vector_count(&conn), 0);
}
