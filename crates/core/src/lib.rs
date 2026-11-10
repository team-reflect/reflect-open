//! The app's commands with no Tauri in them. A shell builds one [`Core`] with
//! its [`Host`] and either calls the typed methods or routes a command name
//! and JSON arguments through [`Core::dispatch`].

pub mod background_task;
pub mod fs;
pub mod recents;
mod secrets;
pub mod settings;
pub mod web_fetch;

use std::sync::Arc;

use reflect_graph_io::GraphState;
use reflect_index::IndexSession;
use reflect_types::{AppError, AppResult};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::background_task::BackgroundTaskState;
use crate::fs::assets::{AssetUploads, UPLOAD_ID_HEADER};
use reflect_graph_io::import::ImportCancel;

/// What the shell provides to the core.
pub trait Host: Send + Sync + 'static {
    /// Sends an event to the frontend.
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Runs `task` on the main thread.
    fn run_on_main(&self, task: Box<dyn FnOnce() + Send>) -> AppResult<()>;
    /// Opens `url` with the system handler.
    fn open_url(&self, url: &str) -> AppResult<()>;
    /// Shows `path` selected in the system file manager.
    #[cfg(not(target_os = "ios"))]
    fn reveal_path(&self, path: &std::path::Path) -> AppResult<()>;
}

/// Values the shell knows at launch.
#[derive(Debug, Clone, Default)]
pub struct CoreConfig {
    /// The HTTP User-Agent for the app's own requests.
    pub user_agent: String,
}

/// The result of [`Core::dispatch`].
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// A serialized JSON value.
    Json(String),
    /// Raw bytes.
    Bytes(Vec<u8>),
}

/// The command implementations, the state they share, the runtime they run
/// on, and the shell's [`Host`].
pub struct Core {
    /// The open graph session.
    pub graph: GraphState,
    /// The open index session.
    pub index: IndexSession,
    /// The native background assertions.
    pub background_tasks: BackgroundTaskState,
    /// The running Reflect V1 import's cancellation flag.
    pub import_cancel: ImportCancel,
    /// The in-flight streamed asset uploads.
    pub asset_uploads: AssetUploads,
    config: CoreConfig,
    host: Arc<dyn Host>,
    runtime: tokio::runtime::Runtime,
}

impl Core {
    /// Builds a core with its own multi-thread runtime.
    pub fn new(config: CoreConfig, host: Arc<dyn Host>) -> AppResult<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        Ok(Self {
            graph: GraphState::default(),
            index: IndexSession::default(),
            background_tasks: BackgroundTaskState::default(),
            import_cancel: ImportCancel::default(),
            asset_uploads: AssetUploads::default(),
            config,
            host,
            runtime,
        })
    }

    /// The values the core was built with.
    pub fn config(&self) -> &CoreConfig {
        &self.config
    }

    /// The shell the core was built with.
    pub fn host(&self) -> &dyn Host {
        self.host.as_ref()
    }

    /// Runs `task` on the blocking thread pool and awaits its result. The
    /// `JoinError` arm only fires when the closure panics.
    pub async fn spawn_blocking<T, F>(&self, task: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce() -> AppResult<T> + Send + 'static,
    {
        self.runtime
            .spawn_blocking(move || drain_autoreleased(task))
            .await
            .map_err(|err| AppError::io(format!("blocking task panicked: {err}")))?
    }

    /// Runs `command` with `args_json`, a JSON object of camelCase arguments.
    /// `headers_json` is a JSON object of the request's lowercase header names
    /// and values, and `body` the raw request body of a binary command.
    pub async fn dispatch(
        self: &Arc<Self>,
        command: &str,
        args_json: &[u8],
        headers_json: &[u8],
        body: Option<&[u8]>,
    ) -> AppResult<Reply> {
        match command {
            "asset_read_binary" => {
                #[derive(serde::Deserialize)]
                struct Args {
                    path: String,
                    generation: u64,
                }
                let Args { path, generation } = parse_args(command, args_json)?;
                return self.asset_read_binary(path, generation).map(Reply::Bytes);
            }
            "asset_upload_append" => {
                let headers: std::collections::HashMap<String, String> =
                    serde_json::from_slice(headers_json).map_err(|err| {
                        AppError::parse(format!("invalid headers for {command}: {err}"))
                    })?;
                let id = headers
                    .get(UPLOAD_ID_HEADER)
                    .ok_or_else(|| AppError::io(format!("missing {UPLOAD_ID_HEADER} header")))?;
                let Some(bytes) = body else {
                    return Err(AppError::io(
                        "asset_upload_append expects a raw binary body, got JSON",
                    ));
                };
                self.asset_upload_append(id, bytes)?;
                return json_reply(&());
            }
            _ => {}
        }
        dispatch_table! { self, command, args_json;
            "settings_load" => settings_load(),
            "settings_save" => settings_save(settings: settings::SettingsDoc),
            "recent_graphs" => recent_graphs(),
            "forget_recent" => forget_recent(root: String),
            "secret_set" => secret_set(name: String, value: String).await,
            "secret_get" => secret_get(name: String).await,
            "secret_delete" => secret_delete(name: String).await,
            "background_task_begin" => background_task_begin() infallible,
            "background_task_end" => background_task_end(token: String) infallible,
            "graph_create" => graph_create(path: String),
            "graph_import_reflect_v1_zip" => graph_import_reflect_v1_zip(path: String, generation: u64).await,
            "graph_import_cancel" => graph_import_cancel() infallible,
            "graph_open" => graph_open(path: String),
            "graph_delete" => graph_delete(generation: u64),
            "note_read" => note_read(path: String, generation: Option<u64>).await,
            "note_read_local" => note_read_local(path: String, generation: Option<u64>).await,
            "note_write" => note_write(path: String, contents: String, generation: u64, check_contents: Option<bool>, expected_contents: Option<String>),
            "note_create" => note_create(path: String, contents: String, generation: u64),
            "note_exists" => note_exists(path: String),
            "note_delete" => note_delete(path: String, generation: u64),
            "asset_write" => asset_write(path: String, contents_base64: String, generation: u64),
            "asset_read" => asset_read(path: String, generation: u64),
            "asset_open" => asset_open(path: String, generation: u64),
            "asset_reveal" => asset_reveal(path: String, generation: u64),
            "audio_memo_delete" => audio_memo_delete(path: String, generation: u64),
            "transcript_cache_read" => transcript_cache_read(name: String, generation: u64),
            "transcript_cache_write" => transcript_cache_write(name: String, contents: String, generation: u64),
            "dir_list" => dir_list(dir: String, generation: u64),
            "list_files" => list_files(generation: Option<u64>).await,
            "list_attachments" => list_attachments(generation: Option<u64>).await,
            "vault_scan_stats" => vault_scan_stats(generation: Option<u64>),
            "asset_upload_begin" => asset_upload_begin(generation: u64),
            "asset_upload_commit" => asset_upload_commit(id: String, desired_name: String, generation: u64),
            "asset_upload_commit_path" => asset_upload_commit_path(id: String, path: String, generation: u64),
            "asset_upload_abort" => asset_upload_abort(id: String),
            "asset_import" => asset_import(source_path: String, desired_name: String, generation: u64).await,
            "audio_memo_import" => audio_memo_import(source_path: String, path: String, generation: u64).await,
            "x_archive_write" => x_archive_write(generation: u64, value: serde_json::Value).await,
            "x_archive_resolve" => x_archive_resolve(generation: u64, post_id: String).await,
            "x_archive_owners" => x_archive_owners(asset_path: String, generation: Option<u64>).await,
            "x_syndication_fetch" => x_syndication_fetch(post_id: String).await,
        }
    }
}

/// Runs `task` inside an autorelease pool. Blocking-pool threads have no pool
/// of their own, so Objective-C objects autoreleased there would otherwise
/// stay alive until the thread exits.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn drain_autoreleased<T>(task: impl FnOnce() -> T) -> T {
    objc2::rc::autoreleasepool(|_| task())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn drain_autoreleased<T>(task: impl FnOnce() -> T) -> T {
    task()
}

fn parse_args<T: DeserializeOwned>(command: &str, args_json: &[u8]) -> AppResult<T> {
    serde_json::from_slice(args_json)
        .map_err(|err| AppError::parse(format!("invalid arguments for {command}: {err}")))
}

fn json_reply<T: Serialize>(value: &T) -> AppResult<Reply> {
    serde_json::to_string(value)
        .map(Reply::Json)
        .map_err(|err| AppError::io(err.to_string()))
}

/// Expands to a `match` on the command name. Each line deserializes a
/// camelCase argument struct, calls the method of the same shape, and
/// serializes its result. A trailing `.await` marks an async method, and a
/// trailing `infallible` a method that returns its value without `AppResult`.
macro_rules! dispatch_table {
    ($core:ident, $command:ident, $args:ident;
     $( $name:literal => $method:ident ( $( $arg:ident : $ty:ty ),* )
        $( . $await:tt )? $( $infallible:ident )? ),* $(,)?) => {
        match $command {
            $( $name => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Args { $( $arg: $ty ),* }
                let Args { $( $arg ),* } = parse_args($command, $args)?;
                json_reply(&method_result!(
                    $core.$method($( $arg ),*) $( . $await )? $( , $infallible )?
                ))
            } )*
            other => Err(AppError::not_found(format!("unknown command: {other}"))),
        }
    };
}
use dispatch_table;

/// The value of one `dispatch_table!` method call, with `?` applied unless
/// the line is marked `infallible`.
macro_rules! method_result {
    ($call:expr) => {
        $call?
    };
    ($call:expr, infallible) => {
        $call
    };
}
use method_result;

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub struct NoopHost;

    impl Host for NoopHost {
        fn emit(&self, _event: &str, _payload: serde_json::Value) {}

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

    pub fn core() -> Arc<Core> {
        Arc::new(Core::new(CoreConfig::default(), Arc::new(NoopHost)).unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::core;
    use super::*;

    #[test]
    fn dispatch_rejects_unknown_commands() {
        let core = core();
        let error = core
            .runtime
            .block_on(core.dispatch("no_such_command", b"{}", b"{}", None))
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound { .. }), "{error:?}");
    }

    #[test]
    fn dispatch_rejects_malformed_arguments() {
        let core = core();
        let error = core
            .runtime
            .block_on(core.dispatch("forget_recent", br#"{"path":"/g"}"#, b"{}", None))
            .unwrap_err();
        assert!(matches!(error, AppError::Parse { .. }), "{error:?}");
    }
}
