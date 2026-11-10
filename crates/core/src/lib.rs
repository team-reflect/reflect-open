//! The app's commands with no Tauri in them. A shell builds one [`Core`] with
//! its [`Host`] and either calls the typed methods or routes a command name
//! and JSON arguments through [`Core::dispatch`].

pub mod background_task;
pub mod capture;
pub mod contacts;
mod db;
pub mod editor_link_preview;
mod git;
pub mod icloud;
mod link_preview;
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
pub struct CoreConfig {
    /// The app-sandbox `Documents/` directory, or `None` when the shell has
    /// none.
    pub document_dir: Option<std::path::PathBuf>,
    /// The app's data directory, when the platform has one.
    pub app_data_dir: Option<PathBuf>,
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
            "mobile_storage" => mobile_storage().await,
            "mobile_storage_local" => mobile_storage_local(),
            "icloud_download_pending" => icloud_download_pending(root: String, notes_only: bool).await,
            "icloud_pending_count" => icloud_pending_count(root: String, notes_only: bool).await,
            "icloud_request_downloads" => icloud_request_downloads(paths: Vec<String>).await,
            "icloud_status" => icloud_status().await,
            "icloud_adopt_graph" => icloud_adopt_graph(generation: u64).await,
            "icloud_conflicts_scan" => icloud_conflicts_scan(generation: u64, skip_paths: Vec<String>, ingested_paths: Vec<String>, record_baseline: bool, scope: icloud::sweep::SweepScope).await,
            "icloud_watch_start" => icloud_watch_start(root: String).await,
            "icloud_watch_stop" => icloud_watch_stop(),
            "contacts_authorization_status" => contacts_authorization_status().await,
            "contacts_request_access" => contacts_request_access().await,
            "contacts_lookup_by_email" => contacts_lookup_by_email(email: String).await,
            "contacts_lookup_by_name" => contacts_lookup_by_name(name: String).await,
            "capture_host_register" => capture_host_register(),
            "capture_inbox_list" => capture_inbox_list(generation: u64),
            "capture_inbox_spool" => capture_inbox_spool(name: String, json: String, generation: u64),
            "capture_inbox_read" => capture_inbox_read(name: String, generation: u64),
            "capture_inbox_remove" => capture_inbox_remove(name: String, generation: u64),
            "capture_inbox_reject" => capture_inbox_reject(name: String, generation: u64),
            "capture_shared_inbox_relay" => capture_shared_inbox_relay(generation: u64).await,
            "capture_quick_note_defaults_write" => capture_quick_note_defaults_write(parent: String).await,
            "capture_screenshot_promote" => capture_screenshot_promote(spool_name: String, asset_path: String, max_dim: u32, generation: u64),
            "capture_link_preview" => capture_link_preview(url: String).await,
            "capture_meta_fetch" => capture_meta_fetch(url: String).await,
            "capture_oembed_fetch" => capture_oembed_fetch(url: String).await,
            "link_preview_fetch_html" => link_preview_fetch_html(url: String).await,
            "link_preview_fetch_icon" => link_preview_fetch_icon(url: String).await,
            "embed_status" => embed_status(),
            #[cfg(not(any(
                target_os = "android",
                target_os = "ios",
                all(target_os = "macos", target_arch = "x86_64")
            )))]
            "embed_ensure" => embed_ensure().await,
            #[cfg(any(
                target_os = "android",
                target_os = "ios",
                all(target_os = "macos", target_arch = "x86_64")
            ))]
            "embed_ensure" => embed_ensure(),
            #[cfg(not(any(
                target_os = "android",
                target_os = "ios",
                all(target_os = "macos", target_arch = "x86_64")
            )))]
            "embed_texts" => embed_texts(texts: Vec<String>).await,
            #[cfg(any(
                target_os = "android",
                target_os = "ios",
                all(target_os = "macos", target_arch = "x86_64")
            ))]
            "embed_texts" => embed_texts(),
            "watch_start" => watch_start(),
            "watch_stop" => watch_stop(),
            "index_open" => index_open(),
            "index_apply" => index_apply(note: reflect_index::IndexedNote, generation: u64),
            "index_apply_batch" => index_apply_batch(notes: Vec<reflect_index::IndexedNote>, generation: u64),
            "index_remove" => index_remove(path: String, generation: u64),
            "index_clear" => index_clear(generation: u64),
            "index_move" => index_move(from: String, to: String, generation: u64, to_address: reflect_index::MovedNoteAddress),
            "index_reconcile_scan" => index_reconcile_scan(generation: u64).await,
            "index_touch" => index_touch(entries: Vec<reflect_index::IndexTouch>, generation: u64),
            "note_move_indexed" => note_move_indexed(request: reflect_index::NoteMoveRequest, generation: u64),
            "index_meta_set" => index_meta_set(key: String, value: String, generation: u64),
            "db_query" => db_query(sql: String, params: Vec<serde_json::Value>).await,
            "chat_message_save" => chat_message_save(conversation: reflect_index::ChatConversation, message: reflect_index::ChatMessageRow, generation: u64),
            "chat_conversation_delete" => chat_conversation_delete(id: String, generation: u64),
            "embed_apply" => embed_apply(path: String, chunks: Vec<reflect_index::EmbeddedChunk>, generation: u64),
            "embed_remove" => embed_remove(path: String, generation: u64),
            "git_status" => git_status(generation: u64).await,
            "git_setup" => git_setup(remote_url: Option<String>, branch: Option<String>, generation: u64).await,
            "git_disconnect" => git_disconnect(generation: u64).await,
            "git_clone" => git_clone(url: String, path: String, credential: Option<reflect_git::GitCredential>).await,
            "git_commit_all" => git_commit_all(message: String, generation: u64).await,
            "git_fetch" => git_fetch(credential: Option<reflect_git::GitCredential>, generation: u64).await,
            "git_remote_head" => git_remote_head(url: Option<String>, credential: Option<reflect_git::GitCredential>, generation: u64).await,
            "git_pull" => git_pull(message: String, generation: u64).await,
            "git_push" => git_push(credential: Option<reflect_git::GitCredential>, generation: u64).await,
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
/// Attributes before a line, such as `#[cfg(...)]`, apply to its match arm.
macro_rules! dispatch_table {
    ($core:ident, $command:ident, $args:ident;
     $( $(#[$attr:meta])* $name:literal => $method:ident ( $( $arg:ident : $ty:ty ),* )
        $( . $await:tt )? $( $infallible:ident )? ),* $(,)?) => {
        match $command {
            $( $(#[$attr])* $name => {
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
