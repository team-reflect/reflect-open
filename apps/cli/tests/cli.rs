//! End-to-end tests: run the real `reflect` binary against fixture graphs.
//! Index fixtures are built with the shared `reflect-index-schema` migrations
//! plus direct row inserts that mirror the desktop's `apply_note` write path
//! (`apps/desktop/src-tauri/src/db/write.rs`), so the CLI is tested against
//! the schema the app actually writes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rusqlite::params;
use tempfile::TempDir;

use reflect_cli::hash::hash_content;
use reflect_cli::keys::fold_key;
use reflect_cli::note_file::parse_note_meta;
use reflect_cli::paths::{daily_path, today_date};

struct Fixture {
    dir: TempDir,
}

impl Fixture {
    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn write_note(&self, rel_path: &str, content: &str) -> PathBuf {
        let absolute = self.root().join(rel_path);
        fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        fs::write(&absolute, content).unwrap();
        absolute
    }

    /// Index every note on disk the way the desktop pipeline would: derived
    /// title/aliases/private, content hash, file mtime, FTS row.
    fn build_index(&self) {
        let conn = reflect_index_schema::open_index_at(self.root()).unwrap();
        for note in reflect_cli::note_file::walk_notes(self.root()).unwrap() {
            let content = fs::read_to_string(self.root().join(&note.rel_path)).unwrap();
            let meta = parse_note_meta(&note.rel_path, &content);
            let daily_date = reflect_cli::paths::date_from_daily_path(&note.rel_path);
            let kind = if daily_date.is_some() {
                "daily"
            } else {
                "note"
            };
            conn.execute(
                "INSERT INTO notes(path, id, title, title_key, kind, daily_date, is_private,
                                   is_pinned, pinned_order, file_hash, mtime, updated_at, preview)
                 VALUES(?1, ?8, ?2, ?3, ?9, ?4, ?5, 0, NULL, ?6, ?7, ?7, '')",
                params![
                    note.rel_path,
                    meta.title,
                    fold_key(&meta.title),
                    daily_date,
                    i64::from(meta.private),
                    hash_content(&content),
                    note.mtime_ms as i64,
                    meta.id,
                    kind,
                ],
            )
            .unwrap();
            for alias in &meta.aliases {
                conn.execute(
                    "INSERT INTO aliases(note_path, alias, alias_key) VALUES(?1, ?2, ?3)",
                    params![note.rel_path, alias, fold_key(alias)],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO search_fts(path, title, body) VALUES(?1, ?2, ?3)",
                params![note.rel_path, meta.title, content],
            )
            .unwrap();
        }
    }
}

/// A graph with the standard layout but no index file.
fn graph() -> Fixture {
    let dir = TempDir::new().unwrap();
    for sub in [".reflect", "daily", "notes"] {
        fs::create_dir_all(dir.path().join(sub)).unwrap();
    }
    Fixture { dir }
}

fn reflect(fixture: &Fixture, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_reflect"))
        .args(args)
        .current_dir(fixture.root())
        .env_remove("REFLECT_GRAPH")
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}

fn json(output: &Output) -> serde_json::Value {
    serde_json::from_str(&stdout(output)).unwrap()
}

// ---- today ------------------------------------------------------------------

#[test]
fn today_prints_the_daily_note_with_no_index() {
    let fixture = graph();
    let content = "remember the milk\n";
    fixture.write_note(&daily_path(&today_date()), content);

    let output = reflect(&fixture, &["today"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), content);
}

#[test]
fn today_path_prints_the_would_be_path_before_the_file_exists() {
    let fixture = graph();
    let output = reflect(&fixture, &["today", "--path"]);
    assert!(output.status.success());
    let expected = daily_path(&today_date());
    assert!(stdout(&output).trim_end().ends_with(&expected));

    let missing = reflect(&fixture, &["today"]);
    assert_eq!(missing.status.code(), Some(3));
    assert!(stderr(&missing).contains("no daily note"));
}

#[test]
fn today_json_shape() {
    let fixture = graph();
    fixture.write_note(&daily_path(&today_date()), "# Plans\nship it\n");

    let value = json(&reflect(&fixture, &["today", "--json"]));
    assert_eq!(value["date"], today_date());
    assert_eq!(value["path"], daily_path(&today_date()));
    assert_eq!(value["title"], "Plans");
    assert_eq!(value["content"], "# Plans\nship it\n");
    assert!(value["absolutePath"].as_str().unwrap().starts_with('/'));
}

#[test]
fn today_refuses_a_private_daily() {
    let fixture = graph();
    fixture.write_note(
        &daily_path(&today_date()),
        "---\nprivate: true\n---\nsecret plans\n",
    );

    let output = reflect(&fixture, &["today"]);
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("private"));

    let path_output = reflect(&fixture, &["today", "--path"]);
    assert_eq!(path_output.status.code(), Some(3));
}

// ---- graph resolution ---------------------------------------------------------

#[test]
fn graph_resolves_by_walking_up_from_a_subdirectory() {
    let fixture = graph();
    let content = "found from a subdir\n";
    fixture.write_note(&daily_path(&today_date()), content);

    let output = Command::new(env!("CARGO_BIN_EXE_reflect"))
        .args(["today"])
        .current_dir(fixture.root().join("notes"))
        .env_remove("REFLECT_GRAPH")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(stdout(&output), content);
}

#[test]
fn explicit_graph_flag_rejects_a_non_graph() {
    let fixture = graph();
    let not_a_graph = TempDir::new().unwrap();
    let output = reflect(
        &fixture,
        &["--graph", not_a_graph.path().to_str().unwrap(), "today"],
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("not a Reflect graph"));
}

#[test]
fn reflect_graph_env_var_resolves_the_graph() {
    let fixture = graph();
    let content = "via env\n";
    fixture.write_note(&daily_path(&today_date()), content);

    let elsewhere = TempDir::new().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_reflect"))
        .args(["today"])
        .current_dir(elsewhere.path())
        .env("REFLECT_GRAPH", fixture.root())
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), content);
}

// ---- search -------------------------------------------------------------------

#[test]
fn search_ranks_hits_and_excludes_private_notes() {
    let fixture = graph();
    fixture.write_note(
        "notes/zebra.md",
        "# Zebra Migration\nzebra migration zebra migration details\n",
    );
    fixture.write_note("notes/other.md", "# Other\nmentions zebra once\n");
    fixture.write_note(
        "notes/secret.md",
        "---\nprivate: true\n---\n# Secret\nzebra zebra zebra\n",
    );
    fixture.build_index();

    let output = reflect(&fixture, &["search", "zebra"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let text = stdout(&output);
    assert!(text.contains("notes/zebra.md"));
    assert!(text.contains("notes/other.md"));
    assert!(!text.contains("secret"));
    let zebra_pos = text.find("notes/zebra.md").unwrap();
    let other_pos = text.find("notes/other.md").unwrap();
    assert!(
        zebra_pos < other_pos,
        "expected zebra.md ranked first:\n{text}"
    );
}

/// Ranking parity with the desktop palette search (`filtered-search.ts`):
/// title hits are bm25-boosted 10× over body hits, so a title-only match must
/// outrank a body-only match.
#[test]
fn search_boosts_title_matches_over_body_matches() {
    let fixture = graph();
    fixture.write_note("notes/title-hit.md", "# Quokka Habitat\nnothing else\n");
    fixture.write_note(
        "notes/body-hit.md",
        "# Unrelated\na quokka appears mid-body\n",
    );
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "quokka"]));
    let title_pos = text.find("notes/title-hit.md").unwrap();
    let body_pos = text.find("notes/body-hit.md").unwrap();
    assert!(
        title_pos < body_pos,
        "expected the title match ranked first:\n{text}"
    );
}

/// The V1-style exact-title boost (`filtered-search.ts`): a note whose title
/// *is* the query ranks ahead of a louder lexical (bm25) match whose title only
/// contains the query among other words — exact title is promoted before bm25.
#[test]
fn search_promotes_exact_title_over_a_stronger_lexical_match() {
    let fixture = graph();
    fixture.write_note("notes/exact.md", "# Zebra\na single zebra\n");
    fixture.write_note(
        "notes/loud.md",
        "# Zebra Zebra Zebra Notes\nzebra zebra zebra zebra\n",
    );
    fixture.build_index();

    let text = stdout(&reflect(&fixture, &["search", "zebra"]));
    let exact_pos = text.find("notes/exact.md").unwrap();
    let loud_pos = text.find("notes/loud.md").unwrap();
    assert!(
        exact_pos < loud_pos,
        "expected the exact-title note ranked first:\n{text}"
    );
}

/// Pinned and recency are tiebreakers *after* exact-title and bm25 ordering:
/// two equally-ranked body hits order pinned-first, and pinned wins over a
/// newer mtime (mirrors the desktop's lexical ordering).
#[test]
fn search_breaks_ties_by_pinned_then_recency() {
    let fixture = graph();
    fixture.write_note("notes/older-pinned.md", "# Notes\napricot apricot\n");
    fixture.write_note("notes/newer-plain.md", "# Notes\napricot apricot\n");
    fixture.build_index();

    // Identical title + body → identical title-rank and bm25; only the
    // tiebreakers differ. Pin the older note: pinned must win over recency.
    let conn = rusqlite::Connection::open(fixture.root().join(".reflect/index.sqlite")).unwrap();
    conn.execute(
        "UPDATE notes SET mtime = 100, is_pinned = 1 WHERE path = 'notes/older-pinned.md'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE notes SET mtime = 200, is_pinned = 0 WHERE path = 'notes/newer-plain.md'",
        [],
    )
    .unwrap();
    drop(conn);

    let text = stdout(&reflect(&fixture, &["search", "apricot"]));
    let pinned_pos = text.find("notes/older-pinned.md").unwrap();
    let plain_pos = text.find("notes/newer-plain.md").unwrap();
    assert!(
        pinned_pos < plain_pos,
        "expected the pinned note ranked before the newer unpinned note:\n{text}"
    );
}

#[test]
fn search_without_an_index_exits_4() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "anything\n");
    let output = reflect(&fixture, &["search", "anything"]);
    assert_eq!(output.status.code(), Some(4));
    assert!(stderr(&output).contains("no search index"));
}

#[test]
fn search_warns_when_the_index_is_stale_but_still_returns_rows() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "alpha content here\n");
    fixture.build_index();
    // An external edit after indexing: same mtime gate can't catch everything,
    // so force divergence (older mtime in the index row + different hash).
    let conn = rusqlite::Connection::open(fixture.root().join(".reflect/index.sqlite")).unwrap();
    conn.execute("UPDATE notes SET mtime = 1, file_hash = 'stale'", [])
        .unwrap();
    drop(conn);

    let output = reflect(&fixture, &["search", "alpha"]);
    assert!(output.status.success());
    assert!(stderr(&output).contains("stale"));
    assert!(stdout(&output).contains("notes/a.md"));

    let value = json(&reflect(&fixture, &["search", "alpha", "--json"]));
    assert_eq!(value["stale"], true);
}

#[test]
fn search_json_shape() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "# Alpha\nsearchable text\n");
    fixture.build_index();

    let value = json(&reflect(&fixture, &["search", "searchable", "--json"]));
    assert_eq!(value["query"], "searchable");
    assert_eq!(value["stale"], false);
    let results = value["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["path"], "notes/a.md");
    assert_eq!(results[0]["title"], "Alpha");
    assert!(results[0]["snippet"]
        .as_str()
        .unwrap()
        .contains("searchable"));
    assert!(results[0]["score"].is_number());
}

#[test]
fn search_drops_a_note_flagged_private_after_indexing() {
    let fixture = graph();
    let note = fixture.write_note("notes/a.md", "# Alpha\nsearchable text\n");
    fixture.build_index();
    fs::write(&note, "---\nprivate: true\n---\n# Alpha\nsearchable text\n").unwrap();

    let output = reflect(&fixture, &["search", "searchable"]);
    assert!(output.status.success());
    assert_eq!(stdout(&output), "", "a just-flagged note must not surface");
}

// ---- show / path ----------------------------------------------------------------

#[test]
fn show_resolves_by_title_alias_date_and_path() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\naliases: [PX]\n---\n# Project X\nthe plan\n",
    );
    fixture.write_note("daily/2026-01-02.md", "daily body\n");
    fixture.build_index();

    for arg in ["Project X", "project x", "PX", "notes/project-x.md"] {
        let output = reflect(&fixture, &["show", arg]);
        assert!(output.status.success(), "show {arg}: {}", stderr(&output));
        assert!(stdout(&output).contains("the plan"), "show {arg}");
    }
    let by_date = reflect(&fixture, &["show", "2026-01-02"]);
    assert_eq!(stdout(&by_date), "daily body\n");

    let missing_daily = reflect(&fixture, &["show", "2026-01-03"]);
    assert_eq!(missing_daily.status.code(), Some(3));

    let unknown = reflect(&fixture, &["show", "No Such Note"]);
    assert_eq!(unknown.status.code(), Some(3));
    assert!(stderr(&unknown).contains("no note matching"));
}

#[test]
fn show_resolves_by_title_and_alias_without_an_index() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\naliases: [PX]\n---\n# Project X\nthe plan\n",
    );

    for arg in ["project x", "PX"] {
        let output = reflect(&fixture, &["show", arg]);
        assert!(output.status.success(), "show {arg}: {}", stderr(&output));
        assert!(stdout(&output).contains("the plan"));
    }
}

#[test]
fn show_blocks_a_private_note_even_when_the_index_says_public() {
    let fixture = graph();
    let note = fixture.write_note("notes/a.md", "# Alpha\npublic at index time\n");
    fixture.build_index();
    fs::write(&note, "---\nprivate: true\n---\n# Alpha\nnow secret\n").unwrap();

    let output = reflect(&fixture, &["show", "Alpha"]);
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(stdout(&output), "");
    assert!(stderr(&output).contains("private"));

    let path_output = reflect(&fixture, &["path", "Alpha"]);
    assert_eq!(path_output.status.code(), Some(3));
}

#[test]
fn show_json_includes_the_daily_date() {
    let fixture = graph();
    fixture.write_note("daily/2026-01-02.md", "daily body\n");

    let value = json(&reflect(&fixture, &["show", "2026-01-02", "--json"]));
    assert_eq!(value["date"], "2026-01-02");
    assert_eq!(value["path"], "daily/2026-01-02.md");
    assert_eq!(value["title"], "2026-01-02");
    assert_eq!(value["content"], "daily body\n");
}

#[test]
fn path_resolves_notes_and_would_be_dailies() {
    let fixture = graph();
    fixture.write_note("notes/project-x.md", "# Project X\n");
    fixture.build_index();

    let by_title = reflect(&fixture, &["path", "Project X"]);
    assert!(by_title.status.success());
    assert!(stdout(&by_title).trim_end().ends_with("notes/project-x.md"));

    let value = json(&reflect(&fixture, &["path", "2099-01-01", "--json"]));
    assert_eq!(value["date"], "2099-01-01");
    assert_eq!(value["path"], "daily/2099-01-01.md");
    assert_eq!(value["exists"], false);

    let existing = json(&reflect(
        &fixture,
        &["path", "notes/project-x.md", "--json"],
    ));
    assert_eq!(existing["exists"], true);
    assert!(existing.get("date").is_none());
}

// ---- open -----------------------------------------------------------------------

#[test]
fn open_print_prefers_the_frontmatter_id() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# Project X\n",
    );
    fixture.build_index();

    let output = reflect(&fixture, &["open", "Project X", "--print"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw\n"
    );
}

#[test]
fn open_print_falls_back_to_the_encoded_path_without_an_id() {
    let fixture = graph();
    fixture.write_note("notes/no id here.md", "# No Id Here\n");
    fixture.build_index();

    let output = reflect(&fixture, &["open", "No Id Here", "--print"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "reflect://note/notes%2Fno%20id%20here.md\n"
    );
}

#[test]
fn open_print_gives_dailies_the_date_form_even_before_the_file_exists() {
    let fixture = graph();

    let would_be = reflect(&fixture, &["open", "2099-01-01", "--print"]);
    assert!(would_be.status.success(), "stderr: {}", stderr(&would_be));
    assert_eq!(stdout(&would_be), "reflect://daily/2099-01-01\n");

    // An existing daily resolved by explicit path gets the date form too.
    fixture.write_note("daily/2026-01-02.md", "daily body\n");
    let by_path = reflect(&fixture, &["open", "daily/2026-01-02.md", "--print"]);
    assert_eq!(stdout(&by_path), "reflect://daily/2026-01-02\n");
}

#[test]
fn open_resolves_by_title_and_alias_without_an_index() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\naliases: [PX]\n---\n# Project X\n",
    );

    for arg in ["project x", "PX"] {
        let output = reflect(&fixture, &["open", arg, "--print"]);
        assert!(output.status.success(), "open {arg}: {}", stderr(&output));
        assert_eq!(
            stdout(&output),
            "reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw\n",
            "open {arg}"
        );
    }
}

#[test]
fn open_refuses_private_notes_and_unknown_targets() {
    let fixture = graph();
    fixture.write_note("notes/a.md", "---\nprivate: true\n---\n# Alpha\n");
    fixture.build_index();

    let private = reflect(&fixture, &["open", "notes/a.md", "--print"]);
    assert_eq!(private.status.code(), Some(3));
    assert_eq!(
        stdout(&private),
        "",
        "a private note's address must not leak"
    );
    assert!(stderr(&private).contains("private"));

    let unknown = reflect(&fixture, &["open", "No Such Note", "--print"]);
    assert_eq!(unknown.status.code(), Some(3));
    assert!(stderr(&unknown).contains("no note matching"));
}

#[test]
fn open_json_shape() {
    let fixture = graph();
    fixture.write_note(
        "notes/project-x.md",
        "---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# Project X\n",
    );
    fixture.build_index();

    let note = json(&reflect(
        &fixture,
        &["open", "Project X", "--print", "--json"],
    ));
    assert_eq!(note["path"], "notes/project-x.md");
    assert_eq!(note["url"], "reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw");
    assert_eq!(note["launched"], false);
    assert!(note.get("date").is_none());

    let daily = json(&reflect(
        &fixture,
        &["open", "2026-01-02", "--json", "--print"],
    ));
    assert_eq!(daily["date"], "2026-01-02");
    assert_eq!(daily["path"], "daily/2026-01-02.md");
    assert_eq!(daily["url"], "reflect://daily/2026-01-02");
}
