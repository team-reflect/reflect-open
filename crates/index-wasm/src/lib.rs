//! The graph index for browsers and tests.
//!
//! [`Index`] runs the index commands of `reflect-index` over an in-memory
//! database. The `wasm32` build exports it to JavaScript as `WasmIndex`.

use std::path::Path;
use std::sync::Mutex;

use reflect_index::{
    INDEX_READ_COMMANDS, INDEX_WRITE_COMMANDS, IndexCommands, IndexConnections, IndexEvents,
    IndexSession,
};
use reflect_types::events::EventName;
use reflect_types::{AppError, AppResult, FileMeta};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// The root that the session is opened for. The database is in memory, so the
/// path only names the session.
const ROOT: &str = "/wasm-index";

/// The commands of this host alone. Three need the caller: the host has no
/// graph root and no file system. `test_query` reads any table, for tests.
const HOST_COMMANDS: &[&str] = &[
    "index_open",
    "index_reconcile_scan",
    "note_move_indexed",
    "test_query",
];

fn schema_error(err: reflect_index_schema::SchemaError) -> AppError {
    AppError::io(err.to_string())
}

/// One in-memory connection: queries run on the writer.
struct MemoryConnections;

impl IndexConnections for MemoryConnections {
    fn open_writer(&self, _root: &Path) -> AppResult<Connection> {
        let mut conn = reflect_index_schema::open_in_memory().map_err(schema_error)?;
        // The wasm build of SQLite leaves foreign keys off, and the write path
        // relies on `ON DELETE CASCADE`.
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        reflect_index_schema::migrate(&mut conn).map_err(schema_error)?;
        let foreign_keys: bool = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
        if !foreign_keys {
            return Err(AppError::io("the index needs SQLite foreign keys"));
        }
        Ok(conn)
    }

    fn open_reader(&self, _root: &Path) -> AppResult<Option<Connection>> {
        Ok(None)
    }
}

/// One event that the native shell would broadcast to the frontend.
#[derive(Serialize)]
struct IndexEvent {
    event: &'static str,
    payload: serde_json::Value,
}

/// The announced writes that the caller has not taken yet.
#[derive(Default)]
struct EventQueue(Mutex<Vec<IndexEvent>>);

impl EventQueue {
    fn push(&self, event: EventName, payload: serde_json::Value) {
        if let Ok(mut events) = self.0.lock() {
            events.push(IndexEvent {
                event: event.as_str(),
                payload,
            });
        }
    }
}

impl IndexEvents for EventQueue {
    fn index_written(&self) {
        self.push(EventName::IndexWritten, serde_json::Value::Null);
    }

    fn note_moved(&self, from: &str, to: &str) {
        self.push(
            EventName::NoteMoved,
            serde_json::json!({ "from": from, "to": to }),
        );
    }

    fn index_reset(&self) {
        self.push(EventName::IndexReconcile, serde_json::Value::Null);
    }
}

/// The arguments of `index_reconcile_scan` on this host: the caller lists the
/// note files and reads the clock.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReconcileScanArgs {
    generation: u64,
    files: Vec<FileMeta>,
    now_ms: u64,
}

/// The arguments of `test_query`: one read-only statement and its values.
#[derive(Deserialize)]
struct TestQueryArgs {
    sql: String,
    params: Vec<serde_json::Value>,
}

fn parse_args<T: serde::de::DeserializeOwned>(command: &str, args_json: &str) -> AppResult<T> {
    serde_json::from_str(args_json)
        .map_err(|err| AppError::parse(format!("invalid arguments for {command}: {err}")))
}

fn json_reply<T: serde::Serialize>(value: &T) -> AppResult<String> {
    serde_json::to_string(value).map_err(|err| AppError::io(err.to_string()))
}

/// One index session over an in-memory database.
#[derive(Default)]
pub struct Index {
    session: IndexSession,
    events: EventQueue,
}

impl Index {
    /// Every command that [`Index::call`] and [`Index::move_note`] answer.
    pub fn commands() -> Vec<&'static str> {
        [HOST_COMMANDS, INDEX_WRITE_COMMANDS, INDEX_READ_COMMANDS].concat()
    }

    /// Runs `command` with `args_json`, a JSON object of camelCase arguments.
    /// The reply is JSON text.
    pub fn call(&self, command: &str, args_json: &str) -> AppResult<String> {
        match command {
            "index_open" => json_reply(&self.session.open(Path::new(ROOT), &MemoryConnections)?),
            "index_reconcile_scan" => {
                let ReconcileScanArgs {
                    generation,
                    files,
                    now_ms,
                } = parse_args(command, args_json)?;
                json_reply(&self.session.reconcile_scan(generation, &files, now_ms)?)
            }
            "test_query" => {
                let TestQueryArgs { sql, params } = parse_args(command, args_json)?;
                let read_generation = self.session.read_generation()?;
                json_reply(&self.session.read(read_generation, |conn| {
                    reflect_index::run_query(conn, &sql, &params)
                })?)
            }
            _ => {
                let read_generation = self.session.read_generation()?;
                IndexCommands::new(&self.session, &self.events, read_generation)
                    .dispatch(command, args_json.as_bytes())
            }
        }
    }

    /// Runs `note_move_indexed`: moves the note's rows, then calls `rename` to
    /// move the file. A failed rename moves the rows back.
    pub fn move_note(
        &self,
        args_json: &str,
        rename: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        let reflect_types::commands::note_move_indexed::Args { request, .. } =
            parse_args("note_move_indexed", args_json)?;
        self.session.move_note(Path::new(ROOT), &request, rename)?;
        self.events.index_written();
        self.events.note_moved(&request.from, &request.to);
        Ok(())
    }

    /// Takes the events of the writes that committed since the last call, as
    /// JSON text: an array of `{ event, payload }`.
    pub fn take_events(&self) -> AppResult<String> {
        let events = match self.events.0.lock() {
            Ok(mut events) => std::mem::take(&mut *events),
            Err(_) => Vec::new(),
        };
        json_reply(&events)
    }
}

#[cfg(target_family = "wasm")]
mod bindings {
    use reflect_types::AppError;
    use wasm_bindgen::prelude::*;

    use super::Index;

    /// The serialized `AppError`: `{ kind, message }` as JSON text.
    fn to_js_error(err: AppError) -> JsValue {
        JsValue::from_str(&serde_json::to_string(&err).unwrap_or_default())
    }

    fn from_js_error(value: JsValue) -> AppError {
        let message = match value.dyn_ref::<js_sys::Error>() {
            Some(error) => String::from(error.message()),
            None => value.as_string().unwrap_or_else(|| format!("{value:?}")),
        };
        AppError::io(message)
    }

    /// One index session over an in-memory database.
    #[wasm_bindgen]
    pub struct WasmIndex(Index);

    #[wasm_bindgen]
    impl WasmIndex {
        #[wasm_bindgen(constructor)]
        pub fn new() -> WasmIndex {
            console_error_panic_hook::set_once();
            WasmIndex(Index::default())
        }

        /// Runs `command`; the reply is JSON text. Throws the serialized
        /// `AppError`.
        pub fn call(&self, command: &str, args_json: &str) -> Result<String, JsValue> {
            self.0.call(command, args_json).map_err(to_js_error)
        }

        /// Takes the events of the committed writes since the last call, as
        /// JSON text.
        pub fn take_events(&self) -> Result<String, JsValue> {
            self.0.take_events().map_err(to_js_error)
        }

        /// Runs `note_move_indexed`; `rename` moves the file. Throws the
        /// serialized `AppError`.
        pub fn move_note(&self, args_json: &str, rename: &js_sys::Function) -> Result<(), JsValue> {
            self.0
                .move_note(args_json, || {
                    rename
                        .call0(&JsValue::NULL)
                        .map(drop)
                        .map_err(from_js_error)
                })
                .map_err(to_js_error)
        }
    }

    impl Default for WasmIndex {
        fn default() -> Self {
            Self::new()
        }
    }

    /// Every command that a `WasmIndex` answers.
    #[wasm_bindgen]
    pub fn index_commands() -> Vec<String> {
        Index::commands().into_iter().map(String::from).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = r##"{"path":"notes/a.md","id":null,"title":"Alpha","titleKey":"alpha","pathKey":"notes/a","kind":"note","dailyDate":null,"isPrivate":false,"isPinned":false,"pinnedOrder":null,"gistUrl":null,"gistStale":false,"fileHash":"h","mtime":1,"preview":"","hasContent":true,"text":"hello world","links":[],"tags":[],"aliases":[],"claims":[],"emails":[],"assets":[],"tasks":[]}"##;

    fn open(index: &Index) -> u64 {
        index.call("index_open", "{}").unwrap().parse().unwrap()
    }

    fn paths(index: &Index) -> String {
        index
            .call(
                "test_query",
                r#"{"sql":"select path from notes order by path","params":[]}"#,
            )
            .unwrap()
    }

    #[test]
    fn applies_and_queries_a_note() {
        let index = Index::default();
        let generation = open(&index);
        let args = format!(r#"{{"note":{NOTE},"generation":{generation}}}"#);
        assert_eq!(index.call("index_apply", &args).unwrap(), "null");
        assert_eq!(paths(&index), r#"[{"path":"notes/a.md"}]"#);
        let hits = index
            .call(
                "test_query",
                r#"{"sql":"select path from search_fts where search_fts match ?","params":["hello"]}"#,
            )
            .unwrap();
        assert_eq!(hits, r#"[{"path":"notes/a.md"}]"#);
    }

    #[test]
    fn a_failed_rename_moves_the_rows_back() {
        let index = Index::default();
        let generation = open(&index);
        let args = format!(r#"{{"note":{NOTE},"generation":{generation}}}"#);
        index.call("index_apply", &args).unwrap();
        let address = r#"{"pathKey":"notes/b","basenameKey":"b","dailyDate":null}"#;
        let from_address = r#"{"pathKey":"notes/a","basenameKey":"a","dailyDate":null}"#;
        let args = format!(
            r#"{{"request":{{"from":"notes/a.md","to":"notes/b.md","toAddress":{address},"fromAddress":{from_address}}},"generation":1}}"#
        );
        let error = index
            .move_note(&args, || Err(AppError::io("disk refused")))
            .unwrap_err();
        assert!(matches!(error, AppError::Io { .. }), "{error:?}");
        assert_eq!(paths(&index), r#"[{"path":"notes/a.md"}]"#);
        assert_eq!(
            index.take_events().unwrap(),
            r#"[{"event":"index:written","payload":null}]"#
        );
        index.move_note(&args, || Ok(())).unwrap();
        assert_eq!(
            index.take_events().unwrap(),
            r#"[{"event":"index:written","payload":null},{"event":"note:moved","payload":{"from":"notes/a.md","to":"notes/b.md"}}]"#
        );
        assert_eq!(index.take_events().unwrap(), "[]");
        assert_eq!(paths(&index), r#"[{"path":"notes/b.md"}]"#);
    }
}
