use super::*;

fn search_rowid(conn: &Connection, path: &str) -> i64 {
    conn.query_row(
        "SELECT rowid FROM note_search WHERE note_path = ?1",
        [path],
        |row| row.get(0),
    )
    .unwrap()
}

fn search_results(conn: &Connection, query: &str) -> Vec<serde_json::Map<String, Value>> {
    run_query(
        conn,
        "SELECT path, highlight(search_fts, 1, '<b>', '</b>') AS title,
         snippet(search_fts, 2, '<b>', '</b>', '…', 12) AS snippet,
         bm25(search_fts) AS score
         FROM search_fts WHERE search_fts MATCH ?1 ORDER BY score, path",
        &[Value::from(query)],
    )
    .unwrap()
}

#[test]
fn fts_identity_migration_preserves_rows_search_and_chat() {
    let mut conn = open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    migrate_to(&mut conn, 20).unwrap();
    conn.execute_batch(
        "INSERT INTO notes(path, id, title, title_key, file_hash) VALUES
         ('notes/a.md', 'duplicate', 'Café', 'café', 'hash-a'),
         ('notes/b.md', 'duplicate', 'Fox', 'fox', 'hash-b'),
         ('notes/c.md', NULL, 'Journal', 'journal', 'hash-c');
         INSERT INTO search_fts(rowid, path, title, body) VALUES
         (7, 'notes/a.md', 'Café', 'A quick café fox. Asset description: waterfall.'),
         (113, 'notes/b.md', 'Fox', 'The quick fox runs past the café.'),
         (202, 'notes/c.md', 'Journal', 'A waterfall behind the trees.');
         INSERT INTO index_meta(key, value) VALUES ('projection_version', 'preserve-me');",
    )
    .unwrap();
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    let rows_before = run_query(
        &conn,
        "SELECT rowid, path, title, body FROM search_fts",
        &[],
    )
    .unwrap();
    let queries = ["café", "\"quick fox\"", "waterfall", "title:Fox", "run*"];
    let results_before: Vec<_> = queries
        .iter()
        .map(|query| search_results(&conn, query))
        .collect();

    migrate(&mut conn).unwrap();
    conn.execute_batch("VACUUM").unwrap();

    assert_eq!(
        run_query(
            &conn,
            "SELECT rowid, path, title, body FROM search_fts",
            &[]
        )
        .unwrap(),
        rows_before
    );
    for (query, before) in queries.iter().zip(results_before) {
        assert_eq!(search_results(&conn, query), before, "{query}");
    }
    for (path, expected) in [("notes/a.md", 7), ("notes/b.md", 113), ("notes/c.md", 202)] {
        assert_eq!(search_rowid(&conn, path), expected);
    }
    assert_eq!(
        run_query(&conn, "SELECT count(*) AS count FROM chat_messages", &[]).unwrap()[0]["count"],
        Value::from(1)
    );
    assert_eq!(
        run_query(
            &conn,
            "SELECT value FROM index_meta WHERE key = 'projection_version'",
            &[]
        )
        .unwrap()[0]["value"],
        Value::from("preserve-me")
    );
    assert!(
        run_query(&conn, "SELECT * FROM pragma_foreign_key_check", &[])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn fts_identity_survives_replacement_rename_and_watcher_echo() {
    let mut conn = migrated();
    let mut first = note("notes/a.md", "Original", vec![]);
    first.id = Some("duplicate".into());
    let mut second = note("notes/b.md", "Second", vec![]);
    second.id = first.id.clone();
    apply_note(&conn, &first).unwrap();
    apply_note(&conn, &second).unwrap();
    apply_note(&conn, &note("notes/no-id.md", "Third", vec![])).unwrap();
    let original_rowid = search_rowid(&conn, &first.path);
    assert_ne!(original_rowid, search_rowid(&conn, &second.path));
    assert_ne!(original_rowid, search_rowid(&conn, "notes/no-id.md"));

    let mut replacement = note(&first.path, "Replacement", vec![]);
    replacement.asset_text = "Hidden waterfall".into();
    apply_note(&conn, &replacement).unwrap();
    assert_eq!(search_rowid(&conn, &replacement.path), original_rowid);
    assert!(search_results(&conn, "Original").is_empty());
    let before_rename = search_results(&conn, "waterfall");
    assert_eq!(before_rename.len(), 1);
    assert_eq!(before_rename[0]["path"], Value::from("notes/a.md"));

    move_in_txn(&mut conn, "notes/a.md", "notes/moved.md").unwrap();
    assert_eq!(search_rowid(&conn, "notes/moved.md"), original_rowid);
    let mut after_rename = search_results(&conn, "waterfall");
    assert_eq!(after_rename[0]["path"], Value::from("notes/moved.md"));
    after_rename[0].insert("path".into(), Value::from("notes/a.md"));
    assert_eq!(after_rename, before_rename);

    super::super::write::remove_note(&conn, "notes/a.md").unwrap();
    replacement.path = "notes/moved.md".into();
    replacement.path_key = replacement.path.clone();
    apply_note(&conn, &replacement).unwrap();
    assert_eq!(search_rowid(&conn, &replacement.path), original_rowid);
    assert_eq!(search_results(&conn, "waterfall").len(), 1);

    super::super::write::remove_note(&conn, "notes/moved.md").unwrap();
    super::super::write::remove_note(&conn, "notes/missing.md").unwrap();
    assert!(search_results(&conn, "waterfall").is_empty());
    assert_eq!(
        run_query(&conn, "SELECT count(*) AS count FROM note_search", &[]).unwrap()[0]["count"],
        Value::from(2)
    );
    assert_eq!(
        run_query(&conn, "SELECT count(*) AS count FROM search_fts", &[]).unwrap()[0]["count"],
        Value::from(2)
    );
}

#[test]
fn fts_rename_collision_leaves_both_identities_and_search_intact() {
    let mut conn = migrated();
    apply_note(&conn, &note("notes/a.md", "First", vec![])).unwrap();
    apply_note(&conn, &note("notes/b.md", "Second", vec![])).unwrap();
    let mapping = run_query(
        &conn,
        "SELECT rowid, note_path FROM note_search ORDER BY rowid",
        &[],
    )
    .unwrap();
    let search = search_results(&conn, "body");

    assert!(move_in_txn(&mut conn, "notes/a.md", "notes/b.md").is_err());
    assert_eq!(
        run_query(
            &conn,
            "SELECT rowid, note_path FROM note_search ORDER BY rowid",
            &[]
        )
        .unwrap(),
        mapping
    );
    assert_eq!(search_results(&conn, "body"), search);
}

#[test]
fn fts_rebuild_clears_identities_and_restores_equivalent_search() {
    let mut conn = migrated();
    let notes = [
        note("notes/a.md", "Quick fox", vec![]),
        note("notes/b.md", "Quick café", vec![]),
    ];
    for indexed in &notes {
        apply_note(&conn, indexed).unwrap();
    }
    save_message(&conn, &conversation("c1"), &chat_message("m1", "c1")).unwrap();
    let before = search_results(&conn, "quick");
    clear_index(&conn).unwrap();
    assert!(run_query(&conn, "SELECT rowid FROM note_search", &[])
        .unwrap()
        .is_empty());
    assert!(search_results(&conn, "quick").is_empty());

    let transaction = conn.transaction().unwrap();
    for indexed in &notes {
        apply_note(&transaction, indexed).unwrap();
    }
    transaction.commit().unwrap();

    assert_eq!(search_results(&conn, "quick"), before);
    assert_eq!(
        run_query(&conn, "SELECT count(*) AS count FROM chat_messages", &[]).unwrap()[0]["count"],
        Value::from(1)
    );
}

#[test]
fn fts_path_resolution_uses_a_covering_index() {
    let conn = migrated();
    let plan: String = conn
        .query_row(
            "EXPLAIN QUERY PLAN SELECT rowid FROM note_search WHERE note_path = ?1",
            ["notes/missing.md"],
            |row| row.get(3),
        )
        .unwrap();
    assert!(
        plan.contains("SEARCH note_search USING COVERING INDEX"),
        "{plan}"
    );
    assert!(plan.contains("(note_path=?)"), "{plan}");
}
