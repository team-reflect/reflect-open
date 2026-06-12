//! TEMPORARY Plan 19 spike-A instrumentation — the simulator verdict is
//! recorded in `docs/plans/19-mobile.md` (step 1); delete once the physical-
//! device half of the gate is recorded too.
//!
//! On mobile startup this exercises the native capabilities the spike must
//! prove on-device — the iOS keychain, SQLite with FTS5, file IO under the
//! app's `Documents/` directory, and libgit2 — logging one loud PASS/FAIL
//! line each, so `tauri ios dev` shows the verdicts in its console stream.

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Manager};

/// Run every probe and log a `[plan19-spike]` verdict line per capability.
pub fn run_self_check(app: &AppHandle) {
    report("keychain round-trip", check_keychain());
    report("sqlite fts5", check_fts5(app));
    report("documents file io", check_documents(app));
    report("libgit2 init+commit", check_git(app));
}

fn report(name: &str, result: Result<(), String>) {
    match result {
        Ok(()) => tracing::info!("[plan19-spike] PASS: {name}"),
        Err(message) => tracing::error!("[plan19-spike] FAIL: {name} — {message}"),
    }
}

fn check_keychain() -> Result<(), String> {
    let entry =
        keyring::Entry::new("app.reflect.plan19-spike", "probe").map_err(|err| err.to_string())?;
    entry
        .set_password("plan19")
        .map_err(|err| err.to_string())?;
    let read = entry.get_password().map_err(|err| err.to_string())?;
    entry.delete_credential().map_err(|err| err.to_string())?;
    if read == "plan19" {
        Ok(())
    } else {
        Err(format!("read back unexpected value {read:?}"))
    }
}

fn check_fts5(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let db_path = dir.join("plan19-spike.sqlite");
    let conn = rusqlite::Connection::open(&db_path).map_err(|err| err.to_string())?;
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS probe USING fts5(body);
         DELETE FROM probe;
         INSERT INTO probe(body) VALUES ('hello from plan nineteen');",
    )
    .map_err(|err| err.to_string())?;
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM probe WHERE probe MATCH 'nineteen'",
            [],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    drop(conn);
    let _ = fs::remove_file(&db_path);
    if hits == 1 {
        Ok(())
    } else {
        Err(format!("FTS5 MATCH returned {hits} rows, expected 1"))
    }
}

fn check_documents(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().document_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let probe = dir.join("plan19-spike.txt");
    fs::write(&probe, "plan19").map_err(|err| err.to_string())?;
    let read = fs::read_to_string(&probe).map_err(|err| err.to_string())?;
    fs::remove_file(&probe).map_err(|err| err.to_string())?;
    if read == "plan19" {
        Ok(())
    } else {
        Err(format!("read back unexpected contents {read:?}"))
    }
}

fn check_git(app: &AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("plan19-spike-git");
    let _ = fs::remove_dir_all(&dir);
    let repo = git2::Repository::init(&dir).map_err(|err| err.to_string())?;
    fs::write(dir.join("a.md"), "spike").map_err(|err| err.to_string())?;
    let mut index = repo.index().map_err(|err| err.to_string())?;
    index
        .add_path(Path::new("a.md"))
        .map_err(|err| err.to_string())?;
    index.write().map_err(|err| err.to_string())?;
    let tree_id = index.write_tree().map_err(|err| err.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|err| err.to_string())?;
    let signature =
        git2::Signature::now("plan19-spike", "spike@reflect.app").map_err(|err| err.to_string())?;
    repo.commit(Some("HEAD"), &signature, &signature, "spike", &tree, &[])
        .map_err(|err| err.to_string())?;
    drop(tree);
    drop(repo);
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
