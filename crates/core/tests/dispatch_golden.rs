//! Runs commands through `Core::dispatch` by name with JSON arguments, the
//! way the Swift shell calls them, and pins each reply.

use std::path::Path;
use std::sync::Arc;

use reflect_core::{Core, CoreConfig, Host, Reply};
use reflect_types::AppResult;
use serde_json::{Value, json};

struct NoopHost;

impl Host for NoopHost {
    fn emit(&self, _event: &str, _payload: Value) {}

    fn run_on_main(&self, task: Box<dyn FnOnce() + Send>) -> AppResult<()> {
        task();
        Ok(())
    }

    fn open_url(&self, _url: &str) -> AppResult<()> {
        Ok(())
    }

    #[cfg(not(target_os = "ios"))]
    fn reveal_path(&self, _path: &Path) -> AppResult<()> {
        Ok(())
    }
}

struct Session {
    core: Arc<Core>,
    waiter: tokio::runtime::Runtime,
}

impl Session {
    fn dispatch(
        &self,
        command: &str,
        args: Value,
        headers: Value,
        body: Option<&[u8]>,
    ) -> AppResult<Reply> {
        let core = Arc::clone(&self.core);
        let command = command.to_owned();
        let args = args.to_string();
        let headers = headers.to_string();
        let body = body.map(<[u8]>::to_vec);
        let call = self.core.spawn_blocking_future(async move {
            core.dispatch(
                &command,
                args.as_bytes(),
                headers.as_bytes(),
                body.as_deref(),
            )
            .await
        });
        self.waiter.block_on(call).unwrap()
    }

    /// The JSON reply of a command that succeeds.
    fn ok(&self, command: &str, args: Value) -> Value {
        match self.dispatch(command, args, json!({}), None) {
            Ok(Reply::Json(json)) => serde_json::from_str(&json).unwrap(),
            Ok(Reply::Bytes(_)) => panic!("{command} replied bytes"),
            Err(error) => panic!("{command} failed: {error:?}"),
        }
    }

    /// The `{kind, message}` JSON of a command that fails.
    fn err(&self, command: &str, args: Value) -> Value {
        match self.dispatch(command, args, json!({}), None) {
            Ok(_) => panic!("{command} succeeded"),
            Err(error) => serde_json::to_value(&error).unwrap(),
        }
    }
}

/// Replaces the values that change between runs: `*Ms` timestamps become 0
/// and the graph path becomes `<graph>`.
fn normalize(value: Value, graph: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(graph, "<graph>")),
        Value::Array(items) => items
            .into_iter()
            .map(|item| normalize(item, graph))
            .collect(),
        Value::Object(fields) => fields
            .into_iter()
            .map(|(key, value)| {
                let value = if key.ends_with("Ms") {
                    json!(0)
                } else {
                    normalize(value, graph)
                };
                (key, value)
            })
            .collect(),
        other => other,
    }
}

#[test]
fn commands_reply_their_pinned_json() {
    let home = tempfile::tempdir().unwrap();
    // The settings and recents stores live under the OS config directory.
    // SAFETY: this is the only test of this binary, and it sets the variables
    // before it starts another thread.
    unsafe {
        std::env::set_var("HOME", home.path());
        std::env::set_var("XDG_CONFIG_HOME", home.path().join("config"));
    }
    let graph = home.path().join("graph");
    let graph = graph.to_str().unwrap();
    let session = Session {
        core: Arc::new(Core::new(CoreConfig::default(), Arc::new(NoopHost)).unwrap()),
        waiter: tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap(),
    };
    let ok = |command: &str, args: Value, expected: Value| {
        assert_eq!(
            normalize(session.ok(command, args), graph),
            expected,
            "{command}"
        );
    };
    let err = |command: &str, args: Value, expected: Value| {
        assert_eq!(session.err(command, args), expected, "{command}");
    };

    ok("settings_load", json!({}), json!({}));
    ok("recent_graphs", json!({}), json!([]));
    ok(
        "graph_create",
        json!({"path": graph}),
        json!({"generation": 1, "name": "graph", "root": "<graph>"}),
    );
    ok(
        "recent_graphs",
        json!({}),
        json!([{"name": "graph", "openedMs": 0, "root": "<graph>"}]),
    );

    ok("note_exists", json!({"path": "notes/a.md"}), json!(false));
    ok(
        "note_create",
        json!({"path": "notes/a.md", "contents": "# A\n", "generation": 1}),
        json!({"kind": "created", "modifiedMs": 0}),
    );
    ok(
        "note_write",
        json!({"path": "notes/a.md", "contents": "# A\n\nb\n", "generation": 1}),
        json!({"merged": null, "modifiedMs": 0}),
    );
    ok(
        "note_read",
        json!({"path": "notes/a.md"}),
        json!("# A\n\nb\n"),
    );
    ok("note_exists", json!({"path": "notes/a.md"}), json!(true));
    let note = json!([{"modifiedMs": 0, "path": "notes/a.md", "size": 7}]);
    ok("list_files", json!({}), note.clone());
    ok("dir_list", json!({"dir": "notes", "generation": 1}), note);

    ok(
        "asset_write",
        json!({"path": "assets/a.txt", "contentsBase64": "aGk=", "generation": 1}),
        json!(null),
    );
    ok(
        "asset_read",
        json!({"path": "assets/a.txt", "generation": 1}),
        json!("aGk="),
    );
    let bytes = session.dispatch(
        "asset_read_binary",
        json!({"path": "assets/a.txt", "generation": 1}),
        json!({}),
        None,
    );
    assert!(matches!(bytes, Ok(Reply::Bytes(bytes)) if bytes == b"hi"));
    ok(
        "list_attachments",
        json!({}),
        json!([{"modifiedMs": 0, "path": "assets/a.txt", "size": 2}]),
    );
    ok(
        "vault_scan_stats",
        json!({}),
        json!({"attachments": 1, "notes": 1, "skipped": 0}),
    );

    ok(
        "asset_upload_begin",
        json!({"generation": 1}),
        json!("upload-1"),
    );
    let appended = session.dispatch(
        "asset_upload_append",
        json!({}),
        json!({"x-upload-id": "upload-1"}),
        Some(b"bytes"),
    );
    assert!(matches!(appended, Ok(Reply::Json(json)) if json == "null"));
    ok(
        "asset_upload_commit",
        json!({"id": "upload-1", "desiredName": "up.bin", "generation": 1}),
        json!("assets/up.bin"),
    );
    assert_eq!(
        std::fs::read(Path::new(graph).join("assets/up.bin")).unwrap(),
        b"bytes"
    );

    ok(
        "transcript_cache_write",
        json!({"name": "t.json", "contents": "{}", "generation": 1}),
        json!(null),
    );
    ok(
        "transcript_cache_read",
        json!({"name": "t.json", "generation": 1}),
        json!("{}"),
    );

    ok("index_open", json!({}), json!(1));
    ok(
        "db_query",
        json!({"sql": "select 1 as n, 'x' as s", "params": []}),
        json!([{"n": 1, "s": "x"}]),
    );
    ok(
        "index_meta_set",
        json!({"key": "k", "value": "v", "generation": 1}),
        json!(null),
    );
    ok(
        "git_status",
        json!({"generation": 1}),
        json!({"ahead": 0, "behind": 0, "branch": null, "initialized": false, "remoteUrl": null}),
    );
    ok(
        "embed_status",
        json!({}),
        json!({"status": "uninitialized"}),
    );
    ok("capture_inbox_list", json!({"generation": 1}), json!([]));

    ok(
        "note_delete",
        json!({"path": "notes/a.md", "generation": 1}),
        json!(null),
    );
    err(
        "note_read",
        json!({"path": "../x.md"}),
        json!({"kind": "traversal", "message": "path escapes the graph root: ../x.md"}),
    );
    err(
        "note_write",
        json!({"path": "notes/b.md", "contents": "", "generation": 999}),
        json!({
            "kind": "io",
            "message": "the graph changed since this command was issued; dropping it",
        }),
    );
    assert_eq!(
        session.err("note_read", json!({"path": "notes/a.md"}))["kind"],
        "notFound"
    );
    assert_eq!(
        session.err("note_write", json!({"path": 1}))["kind"],
        "parse"
    );
    err(
        "no_such_command",
        json!({}),
        json!({"kind": "notFound", "message": "unknown command: no_such_command"}),
    );

    ok("forget_recent", json!({"root": graph}), json!(null));
    ok("recent_graphs", json!({}), json!([]));
    ok(
        "graph_open",
        json!({"path": graph}),
        json!({"generation": 2, "name": "graph", "root": "<graph>"}),
    );
}
