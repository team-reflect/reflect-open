//! The app's commands with no Tauri in them. A shell builds one [`Core`] with
//! its [`Host`] and either calls the typed methods or routes a command name
//! and JSON arguments through [`Core::dispatch`].

pub mod background_task;
pub mod recents;
mod secrets;
pub mod settings;

use std::sync::Arc;

use reflect_graph_io::GraphState;
use reflect_index::IndexSession;
use reflect_types::{AppError, AppResult};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::background_task::BackgroundTaskState;

/// What the shell provides to the core.
pub trait Host: Send + Sync + 'static {
    /// Sends an event to the frontend.
    fn emit(&self, event: &str, payload: serde_json::Value);
    /// Runs `task` on the main thread.
    fn run_on_main(&self, task: Box<dyn FnOnce() + Send>) -> AppResult<()>;
    /// Opens `url` with the system handler.
    fn open_url(&self, url: &str) -> AppResult<()>;
}

/// Values the shell knows at launch.
#[derive(Debug, Clone, Default)]
pub struct CoreConfig {}

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
    pub async fn dispatch(
        self: &Arc<Self>,
        command: &str,
        args_json: &[u8],
        _body: Option<&[u8]>,
    ) -> AppResult<Reply> {
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
            .block_on(core.dispatch("no_such_command", b"{}", None))
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound { .. }), "{error:?}");
    }

    #[test]
    fn dispatch_rejects_malformed_arguments() {
        let core = core();
        let error = core
            .runtime
            .block_on(core.dispatch("forget_recent", br#"{"path":"/g"}"#, None))
            .unwrap_err();
        assert!(matches!(error, AppError::Parse { .. }), "{error:?}");
    }
}
