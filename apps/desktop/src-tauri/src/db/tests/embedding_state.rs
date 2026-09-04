use std::fs::{self, File, FileTimes};
use std::path::Path;

use rusqlite::OptionalExtension;
use tempfile::tempdir;

use super::*;
use crate::db::embed_state::{self, EmbeddingPreparation};

const MODEL: &str = "all-MiniLM-L6-v2";
const VERSION: u32 = 1;
const NOTE: &str = "notes/a.md";

fn pending_paths(conn: &Connection, root: &Path, model: &str, version: u32) -> Vec<String> {
    embed_state::pending(
        embed_state::sources(conn, None).unwrap(),
        root,
        model,
        version,
    )
    .unwrap()
    .into_iter()
    .map(|pending| pending.path)
    .collect()
}

fn preparation(conn: &Connection, root: &Path, path: &str) -> EmbeddingPreparation {
    embed_state::prepare(conn, root, path, MODEL, VERSION)
        .unwrap()
        .expect("note should need work")
}

fn checkpoint(conn: &Connection, path: &str) -> Option<String> {
    conn.query_row(
        "SELECT fingerprint FROM embedding_state WHERE note_path = ?1",
        [path],
        |row| row.get(0),
    )
    .optional()
    .unwrap()
}

fn apply_snapshot(
    conn: &Connection,
    root: &Path,
    path: &str,
    snapshot: &EmbeddingPreparation,
    chunks: &[EmbeddedChunk],
) {
    let transaction = conn.unchecked_transaction().unwrap();
    embed_state::apply(
        &transaction,
        root,
        path,
        &snapshot.fingerprint,
        MODEL,
        VERSION,
        chunks,
    )
    .unwrap();
    transaction.commit().unwrap();
}

fn indexed_asset_note(conn: &Connection, root: &Path) {
    fs::create_dir_all(root.join("assets")).unwrap();
    let mut indexed = note(NOTE, "Asset note", vec![]);
    indexed.assets = vec!["assets/photo.png".into()];
    apply_note(conn, &indexed).unwrap();
}

#[test]
fn migration_preserves_vectors_and_durable_chat_without_claiming_backfill_success() {
    let mut conn = open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    migrate_to(&mut conn, 21).unwrap();
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, file_hash)
         VALUES('notes/a.md', 'A', 'a', 'hash');
         INSERT INTO note_search(note_path) VALUES('notes/a.md');
         INSERT INTO search_fts(rowid, path, title, body)
         SELECT rowid, note_path, 'A', 'A body' FROM note_search;",
    )
    .unwrap();
    apply_chunks(&conn, NOTE, &[chunk("existing", Some(vec384(0.25)))]).unwrap();
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    let vectors = run_query(
        &conn,
        "SELECT rowid, vec_to_json(embedding) AS vector FROM embedding_vectors",
        &[],
    )
    .unwrap();
    let messages = run_query(&conn, "SELECT * FROM chat_messages", &[]).unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(
        run_query(
            &conn,
            "SELECT rowid, vec_to_json(embedding) AS vector FROM embedding_vectors",
            &[]
        )
        .unwrap(),
        vectors
    );
    assert_eq!(
        run_query(&conn, "SELECT * FROM chat_messages", &[]).unwrap(),
        messages
    );
    assert_eq!(checkpoint(&conn, NOTE), None);
    assert_eq!(
        conn.query_row(
            "SELECT projection_path FROM notes WHERE path = ?1",
            [NOTE],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        NOTE
    );
    let root = tempdir().unwrap();
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
}

#[test]
fn empty_success_is_a_no_op_across_identical_reprojection() {
    let conn = migrated();
    let root = tempdir().unwrap();
    index_note(&conn, NOTE);
    let snapshot = preparation(&conn, root.path(), NOTE);
    apply_snapshot(&conn, root.path(), NOTE, &snapshot, &[]);
    assert_eq!(checkpoint(&conn, NOTE), Some(snapshot.fingerprint));
    let changes = conn.total_changes();
    assert!(pending_paths(&conn, root.path(), MODEL, VERSION).is_empty());
    assert!(
        embed_state::prepare(&conn, root.path(), NOTE, MODEL, VERSION)
            .unwrap()
            .is_none()
    );
    assert_eq!(conn.total_changes(), changes);

    index_note(&conn, NOTE);
    assert!(pending_paths(&conn, root.path(), MODEL, VERSION).is_empty());
    assert_eq!(vector_count(&conn), 0);
}

#[test]
fn content_model_and_projection_version_invalidate_success() {
    let conn = migrated();
    let root = tempdir().unwrap();
    index_note(&conn, NOTE);
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[],
    );
    assert_eq!(
        pending_paths(&conn, root.path(), "replacement-model", VERSION),
        [NOTE]
    );
    assert_eq!(
        pending_paths(&conn, root.path(), MODEL, VERSION + 1),
        [NOTE]
    );

    let mut changed = note(NOTE, "Changed", vec![]);
    changed.file_hash = "new-file-hash".into();
    apply_note(&conn, &changed).unwrap();
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
    assert_eq!(
        preparation(&conn, root.path(), NOTE).file_hash,
        changed.file_hash
    );
}

#[test]
fn sidecar_creation_deletion_and_same_size_replacement_invalidate_success() {
    let conn = migrated();
    let root = tempdir().unwrap();
    indexed_asset_note(&conn, root.path());
    let sidecar = root.path().join("assets/photo.png.reflect.md");
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[],
    );

    fs::write(&sidecar, "A red flower.").unwrap();
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[],
    );

    let modified = fs::metadata(&sidecar).unwrap().modified().unwrap();
    let replacement = root.path().join("assets/replacement");
    fs::write(&replacement, "A tan flower.").unwrap();
    File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(FileTimes::new().set_modified(modified))
        .unwrap();
    fs::rename(replacement, &sidecar).unwrap();
    assert_eq!(
        fs::metadata(&sidecar).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[],
    );

    fs::remove_file(sidecar).unwrap();
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
}

#[test]
#[cfg(any(unix, windows))]
fn in_place_same_size_sidecar_edit_with_restored_mtime_invalidates_success() {
    let conn = migrated();
    let root = tempdir().unwrap();
    indexed_asset_note(&conn, root.path());
    let sidecar = root.path().join("assets/photo.png.reflect.md");
    fs::write(&sidecar, "old description").unwrap();
    let modified = fs::metadata(&sidecar).unwrap().modified().unwrap();
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[],
    );

    fs::write(&sidecar, "new description").unwrap();
    File::options()
        .write(true)
        .open(&sidecar)
        .unwrap()
        .set_times(FileTimes::new().set_modified(modified))
        .unwrap();

    assert_eq!(
        fs::metadata(&sidecar).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
}

#[test]
fn raced_sidecar_revision_preserves_old_vectors_and_checkpoint() {
    let conn = migrated();
    let root = tempdir().unwrap();
    indexed_asset_note(&conn, root.path());
    let sidecar = root.path().join("assets/photo.png.reflect.md");
    fs::write(&sidecar, "first revision").unwrap();
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[chunk("first", Some(vec384(0.1)))],
    );
    let saved = checkpoint(&conn, NOTE);
    fs::write(&sidecar, "second revision").unwrap();
    let stale = preparation(&conn, root.path(), NOTE);
    fs::write(&sidecar, "third revision with different length").unwrap();

    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &stale,
        &[chunk("stale", Some(vec384(0.2)))],
    );

    assert_eq!(checkpoint(&conn, NOTE), saved);
    assert_eq!(chunk_rows(&conn), [(NOTE.to_string(), "first".to_string())]);
    assert_eq!(vector_count(&conn), 1);
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
}

#[test]
fn deleted_and_recreated_paths_reject_an_old_content_snapshot() {
    let conn = migrated();
    let root = tempdir().unwrap();
    index_note(&conn, NOTE);
    let stale = preparation(&conn, root.path(), NOTE);
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &stale,
        &[chunk("old", Some(vec384(0.1)))],
    );
    let transaction = conn.unchecked_transaction().unwrap();
    crate::db::write::remove_note(&transaction, NOTE).unwrap();
    remove_chunks(&transaction, NOTE).unwrap();
    transaction.commit().unwrap();
    assert_eq!(checkpoint(&conn, NOTE), None);
    assert_eq!(vector_count(&conn), 0);
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &stale,
        &[chunk("stale", Some(vec384(0.2)))],
    );
    assert!(chunk_rows(&conn).is_empty());

    let mut recreated = note(NOTE, "Recreated", vec![]);
    recreated.file_hash = "new-content".into();
    apply_note(&conn, &recreated).unwrap();
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &stale,
        &[chunk("stale", Some(vec384(0.2)))],
    );
    assert!(chunk_rows(&conn).is_empty());
    assert_eq!(checkpoint(&conn, NOTE), None);
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
}

#[test]
fn renames_preserve_vectors_but_recheck_path_and_changed_asset_references() {
    let conn = migrated();
    let root = tempdir().unwrap();
    indexed_asset_note(&conn, root.path());
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[chunk("body", Some(vec384(0.1)))],
    );
    let saved = checkpoint(&conn, NOTE);
    let destination = "notes/subdirectory/renamed.md";
    let transaction = conn.unchecked_transaction().unwrap();
    transaction
        .execute_batch("PRAGMA defer_foreign_keys=ON")
        .unwrap();
    move_note(
        &transaction,
        NOTE,
        destination,
        &MovedNoteAddress {
            path_key: destination.into(),
            basename_key: "renamed".into(),
            daily_date: None,
        },
    )
    .unwrap();
    transaction.commit().unwrap();

    assert_eq!(checkpoint(&conn, NOTE), None);
    assert_eq!(checkpoint(&conn, destination), saved);
    assert_eq!(
        chunk_rows(&conn),
        [(destination.to_string(), "body".to_string())]
    );
    let moved = preparation(&conn, root.path(), destination);
    assert_ne!(Some(moved.fingerprint.clone()), saved);
    let mut reprojected = note(destination, "Asset note", vec![]);
    reprojected.assets = vec!["notes/subdirectory/photo.png".into()];
    apply_note(&conn, &reprojected).unwrap();
    let refreshed = preparation(&conn, root.path(), destination);
    assert_eq!(refreshed.asset_paths, reprojected.assets);
    assert_ne!(refreshed.fingerprint, moved.fingerprint);
    apply_snapshot(
        &conn,
        root.path(),
        destination,
        &refreshed,
        &[chunk("body", None)],
    );
    assert!(pending_paths(&conn, root.path(), MODEL, VERSION).is_empty());
    assert_eq!(vector_count(&conn), 1);
}

#[test]
fn renamed_projection_survives_reopen_until_refresh_despite_unchanged_mtime_and_hash() {
    let root = tempdir().unwrap();
    let conn = open_index_at(root.path()).unwrap();
    let mut original = note(NOTE, "Title", vec![]);
    original.assets = vec!["notes/photo.png".into()];
    original.mtime = 1_000;
    apply_note(&conn, &original).unwrap();
    apply_chunks(&conn, NOTE, &[chunk("body", Some(vec384(0.1)))]).unwrap();
    let destination = "notes/meetings/renamed.md";
    let transaction = conn.unchecked_transaction().unwrap();
    transaction
        .execute_batch("PRAGMA defer_foreign_keys=ON")
        .unwrap();
    move_note(
        &transaction,
        NOTE,
        destination,
        &MovedNoteAddress {
            path_key: destination.into(),
            basename_key: "renamed".into(),
            daily_date: None,
        },
    )
    .unwrap();
    transaction.commit().unwrap();
    drop(conn);

    let conn = open_index_at(root.path()).unwrap();
    let mut files = [crate::fs::FileMeta {
        path: destination.into(),
        size: 10,
        modified_ms: 1_000,
        placeholder: false,
    }];
    let scan = scan_reconcile(&conn, &files, 100_000).unwrap();
    assert_eq!(scan.candidates.len(), 1);
    assert!(scan.candidates[0].needs_projection);
    assert_eq!(scan.candidates[0].stored_mtime, Some(original.mtime));
    assert_eq!(
        scan.candidates[0].stored_hash.as_ref(),
        Some(&original.file_hash)
    );
    assert_eq!(vector_count(&conn), 1);

    files[0].placeholder = true;
    let evicted = scan_reconcile(&conn, &files, 100_000).unwrap();
    assert!(evicted.candidates.is_empty());
    assert!(evicted.stale_placeholders.is_empty());
    assert_eq!(vector_count(&conn), 1);

    original.path = destination.into();
    original.path_key = destination.into();
    original.assets = vec!["notes/meetings/photo.png".into()];
    apply_note(&conn, &original).unwrap();
    files[0].placeholder = false;
    assert!(scan_reconcile(&conn, &files, 100_000)
        .unwrap()
        .candidates
        .is_empty());
    assert_eq!(
        conn.query_row(
            "SELECT asset_path FROM assets WHERE note_path = ?1",
            [destination],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "notes/meetings/photo.png"
    );
    assert_eq!(vector_count(&conn), 1);
}

#[test]
fn evicted_sidecar_defers_work_preserving_the_last_success() {
    let conn = migrated();
    let root = tempdir().unwrap();
    indexed_asset_note(&conn, root.path());
    let sidecar = root.path().join("assets/photo.png.reflect.md");
    fs::write(&sidecar, "local description").unwrap();
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[chunk("local", Some(vec384(0.1)))],
    );
    let saved = checkpoint(&conn, NOTE);
    fs::remove_file(&sidecar).unwrap();
    let placeholder = crate::fs::eviction_placeholder(&sidecar).unwrap();
    fs::write(&placeholder, "stub").unwrap();

    assert!(pending_paths(&conn, root.path(), MODEL, VERSION).is_empty());
    assert!(
        embed_state::prepare(&conn, root.path(), NOTE, MODEL, VERSION)
            .unwrap()
            .is_none()
    );
    assert_eq!(checkpoint(&conn, NOTE), saved);
    assert_eq!(vector_count(&conn), 1);

    fs::remove_file(placeholder).unwrap();
    fs::write(sidecar, "materialized changed description").unwrap();
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
}

#[test]
fn failed_apply_rolls_back_chunks_and_does_not_checkpoint() {
    let conn = migrated();
    let root = tempdir().unwrap();
    index_note(&conn, NOTE);
    let snapshot = preparation(&conn, root.path(), NOTE);
    {
        let transaction = conn.unchecked_transaction().unwrap();
        let result = embed_state::apply(
            &transaction,
            root.path(),
            NOTE,
            &snapshot.fingerprint,
            MODEL,
            VERSION,
            &[chunk("new", Some(vec384(0.1))), chunk("missing", None)],
        );
        assert!(result.is_err());
    }
    assert_eq!(checkpoint(&conn, NOTE), None);
    assert_eq!(vector_count(&conn), 0);
    assert!(chunk_rows(&conn).is_empty());
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &snapshot,
        &[chunk("new", Some(vec384(0.1)))],
    );
    assert!(pending_paths(&conn, root.path(), MODEL, VERSION).is_empty());
}

#[test]
fn model_mismatch_and_cross_model_vector_reuse_are_rejected() {
    let conn = migrated();
    let root = tempdir().unwrap();
    index_note(&conn, NOTE);
    apply_chunks(&conn, NOTE, &[chunk("shared", Some(vec384(0.1)))]).unwrap();
    let changed_model = "different-model";
    let snapshot = embed_state::prepare(&conn, root.path(), NOTE, changed_model, VERSION)
        .unwrap()
        .unwrap();
    assert!(embed_state::apply(
        &conn,
        root.path(),
        NOTE,
        &snapshot.fingerprint,
        changed_model,
        VERSION,
        &[chunk("shared", None)]
    )
    .is_err());
    let mut reused = chunk("shared", None);
    reused.model_id = changed_model.into();
    assert!(embed_state::apply(
        &conn,
        root.path(),
        NOTE,
        &snapshot.fingerprint,
        changed_model,
        VERSION,
        &[reused]
    )
    .is_err());
    assert_eq!(checkpoint(&conn, NOTE), None);
    assert_eq!(vector_count(&conn), 1);
    assert_eq!(
        run_query(&conn, "SELECT model_id FROM embedding_chunks", &[]).unwrap()[0]["model_id"],
        Value::from(MODEL)
    );
}

#[test]
fn rebuild_clears_success_but_preserves_durable_chat() {
    let conn = migrated();
    let root = tempdir().unwrap();
    index_note(&conn, NOTE);
    apply_snapshot(
        &conn,
        root.path(),
        NOTE,
        &preparation(&conn, root.path(), NOTE),
        &[chunk("body", Some(vec384(0.1)))],
    );
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    clear_index(&conn).unwrap();
    assert_eq!(checkpoint(&conn, NOTE), None);
    assert_eq!(vector_count(&conn), 0);
    assert_eq!(
        run_query(&conn, "SELECT count(*) AS count FROM chat_messages", &[]).unwrap()[0]["count"],
        Value::from(1)
    );
    index_note(&conn, NOTE);
    assert_eq!(pending_paths(&conn, root.path(), MODEL, VERSION), [NOTE]);
}

#[test]
#[ignore = "synthetic native discovery benchmark; run explicitly with --ignored --nocapture"]
fn benchmark_clean_and_single_dirty_discovery() {
    for count in [1_000, 10_000] {
        let conn = migrated();
        let root = tempdir().unwrap();
        let transaction = conn.unchecked_transaction().unwrap();
        for ordinal in 0..count {
            index_note(&transaction, &format!("notes/{ordinal}.md"));
        }
        let initial = embed_state::pending(
            embed_state::sources(&transaction, None).unwrap(),
            root.path(),
            MODEL,
            VERSION,
        )
        .unwrap();
        for pending in initial {
            embed_state::save(&transaction, &pending.path, &pending.fingerprint).unwrap();
        }
        transaction.commit().unwrap();
        for dirty in [false, true] {
            if dirty {
                conn.execute(
                    "UPDATE notes SET file_hash = 'changed' WHERE path = 'notes/0.md'",
                    [],
                )
                .unwrap();
            }
            let changes = conn.total_changes();
            let started = std::time::Instant::now();
            let pending = pending_paths(&conn, root.path(), MODEL, VERSION);
            let elapsed = started.elapsed();
            assert_eq!(pending.len(), usize::from(dirty));
            assert_eq!(conn.total_changes(), changes);
            println!(
                "EMBED_DISCOVERY notes={count} pending={} elapsed_ms={:.3} sqlite_writes=0",
                pending.len(),
                elapsed.as_secs_f64() * 1_000.0
            );
        }
    }
}

#[test]
fn command_reads_use_the_index_root_and_stale_generations_cannot_mutate_success() {
    use tauri::Manager;

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(crate::fs::GraphState::default());
    app.manage(crate::db::IndexState::default());
    app.manage(crate::background_task::BackgroundTaskState::default());
    let original = tempdir().unwrap();
    let replacement = tempdir().unwrap();
    for (root, content) in [(&original, "original graph"), (&replacement, "new graph")] {
        fs::create_dir_all(root.path().join("notes")).unwrap();
        fs::create_dir_all(root.path().join("assets")).unwrap();
        fs::write(root.path().join(NOTE), content).unwrap();
        fs::write(root.path().join("assets/photo.png.reflect.md"), content).unwrap();
    }
    {
        let graph: tauri::State<crate::fs::GraphState> = app.state();
        let mut state = graph.0.lock().unwrap();
        state.generation = 3;
        state.root = Some(original.path().to_path_buf());
    }
    let stale = crate::db::index_open(app.state(), app.state(), app.state()).unwrap();
    crate::db::index_apply(
        note(NOTE, "Original", vec![]),
        stale,
        app.handle().clone(),
        app.state(),
        app.state(),
    )
    .unwrap();
    let old_snapshot =
        crate::db::embed_prepare(NOTE.into(), MODEL.into(), VERSION, stale, app.state())
            .unwrap()
            .unwrap();
    {
        let graph: tauri::State<crate::fs::GraphState> = app.state();
        let mut state = graph.0.lock().unwrap();
        state.generation += 1;
        state.root = Some(replacement.path().to_path_buf());
    }
    for path in [NOTE, "assets/photo.png.reflect.md"] {
        let read =
            tauri::async_runtime::block_on(crate::db::embed_read(path.into(), stale, app.state()))
                .unwrap();
        match read {
            crate::fs::LocalNoteRead::Content { content } => assert_eq!(content, "original graph"),
            crate::fs::LocalNoteRead::Evicted => panic!("fixture is local"),
        }
    }
    let evicted = original.path().join("notes/evicted.md");
    fs::write(crate::fs::eviction_placeholder(&evicted).unwrap(), "stub").unwrap();
    assert!(matches!(
        tauri::async_runtime::block_on(crate::db::embed_read(
            "notes/evicted.md".into(),
            stale,
            app.state()
        ))
        .unwrap(),
        crate::fs::LocalNoteRead::Evicted
    ));

    let fresh = crate::db::index_open(app.state(), app.state(), app.state()).unwrap();
    assert_ne!(fresh, stale);
    crate::db::index_apply(
        note(NOTE, "New graph", vec![]),
        fresh,
        app.handle().clone(),
        app.state(),
        app.state(),
    )
    .unwrap();
    let current = crate::db::embed_prepare(NOTE.into(), MODEL.into(), VERSION, fresh, app.state())
        .unwrap()
        .unwrap();
    crate::db::embed_apply(
        crate::db::EmbedApplyRequest {
            path: NOTE.into(),
            chunks: vec![chunk("current", Some(vec384(0.2)))],
            fingerprint: current.fingerprint.clone(),
            model_id: MODEL.into(),
            projection_version: VERSION,
        },
        fresh,
        app.state(),
        app.state(),
    )
    .unwrap();

    assert!(
        crate::db::embed_prepare(NOTE.into(), MODEL.into(), VERSION, stale, app.state())
            .unwrap()
            .is_none()
    );
    assert!(tauri::async_runtime::block_on(crate::db::embed_pending(
        MODEL.into(),
        VERSION,
        stale,
        app.handle().clone()
    ))
    .unwrap()
    .is_empty());
    assert!(
        tauri::async_runtime::block_on(crate::db::embed_read(NOTE.into(), stale, app.state()))
            .is_err()
    );
    crate::db::embed_apply(
        crate::db::EmbedApplyRequest {
            path: NOTE.into(),
            chunks: vec![chunk("stale", Some(vec384(0.1)))],
            fingerprint: old_snapshot.fingerprint,
            model_id: MODEL.into(),
            projection_version: VERSION,
        },
        stale,
        app.state(),
        app.state(),
    )
    .unwrap();
    crate::db::embed_remove(NOTE.into(), stale, app.state(), app.state()).unwrap();

    let index: tauri::State<crate::db::IndexState> = app.state();
    let state = index.inner.lock().unwrap();
    let conn = state.conn.as_ref().unwrap();
    assert_eq!(checkpoint(conn, NOTE), Some(current.fingerprint));
    assert_eq!(
        chunk_rows(conn),
        [(NOTE.to_string(), "current".to_string())]
    );
    assert_eq!(vector_count(conn), 1);
}

#[test]
fn migration_repairs_historical_asset_references_without_hydrating_evicted_notes() {
    let mut conn = open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    migrate_to(&mut conn, 22).unwrap();
    conn.execute_batch(
        "INSERT INTO notes(path, title, title_key, file_hash, mtime)
         VALUES('notes/moved.md', 'Moved', 'moved', 'same', 1000),
               ('notes/plain.md', 'Plain', 'plain', 'same', 1000);
         INSERT INTO assets(note_path, asset_path) VALUES('notes/moved.md', 'old/photo.png');",
    )
    .unwrap();
    apply_chunks(&conn, "notes/moved.md", &[chunk("body", Some(vec384(0.1)))]).unwrap();
    migrate(&mut conn).unwrap();
    let mut files = [
        crate::fs::FileMeta {
            path: "notes/moved.md".into(),
            size: 10,
            modified_ms: 1000,
            placeholder: false,
        },
        crate::fs::FileMeta {
            path: "notes/plain.md".into(),
            size: 10,
            modified_ms: 1000,
            placeholder: false,
        },
    ];
    let local = scan_reconcile(&conn, &files, 100_000).unwrap();
    assert_eq!(local.candidates.len(), 1);
    assert_eq!(local.candidates[0].path, "notes/moved.md");
    assert!(local.candidates[0].needs_projection);
    files[0].placeholder = true;
    let evicted = scan_reconcile(&conn, &files, 100_000).unwrap();
    assert!(evicted.candidates.is_empty());
    assert!(evicted.stale_placeholders.is_empty());
    assert_eq!(vector_count(&conn), 1);
}
