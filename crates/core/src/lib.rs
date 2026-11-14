//! The app's commands with no Tauri in them. A shell builds one [`Core`] with
//! its [`Host`] and either calls the typed methods or routes a command name
//! and JSON arguments through [`Core::dispatch`].

pub mod background_task;
pub mod capture;
pub mod contacts;
mod db;
pub mod editor_link_preview;
pub mod fs;
mod git;
pub mod icloud;
mod link_preview;
pub mod logging;
pub mod recents;
mod secrets;
pub mod settings;
pub mod web_fetch;

// The watcher and the embedding runtime are desktop capabilities, and Intel
// macOS has no embedding runtime either: other platforms swap in stand-ins
// with the same `Core` methods.
#[cfg(not(any(
    target_os = "android",
    target_os = "ios",
    all(target_os = "macos", target_arch = "x86_64")
)))]
pub mod embed;
#[cfg(any(
    target_os = "android",
    target_os = "ios",
    all(target_os = "macos", target_arch = "x86_64")
))]
#[path = "embed_unsupported.rs"]
pub mod embed;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod watcher;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "watcher_mobile.rs"]
pub mod watcher;

use std::path::PathBuf;
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
    /// Runs `task` on the main thread. Can wait for the main thread.
    fn run_on_main(&self, task: Box<dyn FnOnce() + Send>) -> AppResult<()>;
    /// Opens `url` with the system handler. Can wait for the main thread, so
    /// call it from a blocking-pool thread.
    fn open_url(&self, url: &str) -> AppResult<()>;
    /// Shows `path` selected in the system file manager.
    #[cfg(not(target_os = "ios"))]
    fn reveal_path(&self, path: &std::path::Path) -> AppResult<()>;
}

/// Values the shell knows at launch.
#[derive(Debug, Clone, Default)]
pub struct CoreConfig {
    /// The app-sandbox `Documents/` directory, or `None` when the shell has
    /// none.
    pub document_dir: Option<std::path::PathBuf>,
    /// The app's data directory, when the platform has one.
    pub app_data_dir: Option<PathBuf>,
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
    /// The file watcher over the open graph.
    pub watcher: watcher::WatcherState,
    /// The embedding runtime.
    pub embed: embed::EmbedState,
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
            watcher: Default::default(),
            embed: Default::default(),
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

    /// Runs `task` to completion on a blocking-pool thread, inside an
    /// autorelease pool. A command body that blocks then holds a blocking
    /// thread instead of one of the async worker threads.
    pub fn spawn_blocking_future<F>(&self, task: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let handle = self.runtime.handle().clone();
        self.runtime
            .spawn_blocking(move || drain_autoreleased(|| handle.block_on(task)))
    }

    /// Whether [`Core::dispatch`] has `command`.
    pub fn has_command(command: &str) -> bool {
        BINARY_COMMANDS.contains(&command) || JSON_COMMANDS.contains(&command)
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
        dispatch_json(self, command, args_json).await
    }
}

/// The commands with a binary body or a binary reply.
const BINARY_COMMANDS: &[&str] = &["asset_read_binary", "asset_upload_append"];

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

/// Defines `JSON_COMMANDS` and `dispatch_json` from the command table in
/// `reflect_types::commands`. Each command deserializes its `Args`, calls the
/// `Core` method of the same name, and serializes the result, which must have
/// the table's result type.
macro_rules! dispatch_table {
    (
        core { $( $method:ident ( $( $arg:ident : $ty:ty ),* ) $( . $await:tt )? $( $infallible:ident )? -> $ret:ty ),* $(,)? }
        desktop { $( $desktop:tt )* }
        shell { $( $shell:tt )* }
    ) => {
        /// The commands with JSON arguments and a JSON reply.
        const JSON_COMMANDS: &[&str] = &[$( stringify!($method) ),*];

        async fn dispatch_json(core: &Arc<Core>, command: &str, args_json: &[u8]) -> AppResult<Reply> {
            match command {
                $( stringify!($method) => {
                    let reflect_types::commands::$method::Args { $( $arg ),* } =
                        parse_args(command, args_json)?;
                    let value: reflect_types::commands::$method::Result = method_result!(
                        core.$method($( $arg ),*) $( . $await )? $( , $infallible )?
                    );
                    json_reply(&value)
                } )*
                other => Err(AppError::not_found(format!("unknown command: {other}"))),
            }
        }
    };
}

reflect_types::commands!(dispatch_table);

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
