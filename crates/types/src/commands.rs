//! The command table: every command the frontend calls through the Rust core,
//! the desktop shell or the Swift shell, with its arguments and result.

#[allow(unused_imports)]
use crate::*;

/// Calls `$callback!` with the command table.
///
/// A `core` row names a `Core` method; `.await` marks an async method and
/// `infallible` one that returns its value without `AppResult`. A `desktop`
/// row names a Tauri command by its module path and lists only the arguments
/// the frontend sends. A `shell` row maps a Swift shell command name to an
/// identifier, its arguments type and its result.
#[macro_export]
macro_rules! commands {
    ($callback:ident) => {
        $callback! {
            core {
                settings_load() -> SettingsDoc,
                settings_save(settings: SettingsDoc) -> (),
                recent_graphs() -> Vec<RecentGraph>,
                forget_recent(root: String) -> (),
                secret_set(name: String, value: String).await -> (),
                secret_get(name: String).await -> Option<String>,
                secret_delete(name: String).await -> (),
                background_task_begin() infallible -> Option<String>,
                background_task_end(token: String) infallible -> (),
                mobile_storage().await -> MobileStorageInfo,
                mobile_storage_local() -> String,
                icloud_download_pending(root: String, notes_only: bool).await -> u32,
                icloud_pending_count(root: String, notes_only: bool).await -> u32,
                icloud_request_downloads(paths: Vec<String>).await -> u32,
                icloud_status().await -> IcloudStatus,
                icloud_adopt_graph(generation: u64).await -> String,
                icloud_conflicts_scan(generation: u64, skip_paths: Vec<String>, ingested_paths: Vec<String>, record_baseline: bool, scope: SweepScope).await -> IcloudSweepOutcome,
                icloud_watch_start(root: String).await -> (),
                icloud_watch_stop() -> (),
                contacts_authorization_status().await -> ContactsAuthorization,
                contacts_request_access().await -> bool,
                contacts_lookup_by_email(email: String).await -> Vec<ContactMatch>,
                contacts_lookup_by_name(name: String).await -> Vec<ContactMatch>,
                capture_host_register() -> (),
                capture_inbox_list(generation: u64) -> Vec<FileMeta>,
                capture_inbox_spool(name: String, json: String, generation: u64) -> (),
                capture_inbox_read(name: String, generation: u64) -> String,
                capture_inbox_remove(name: String, generation: u64) -> (),
                capture_inbox_reject(name: String, generation: u64) -> (),
                capture_shared_inbox_relay(generation: u64).await -> u32,
                capture_quick_note_defaults_write(parent: String).await -> (),
                capture_screenshot_promote(spool_name: String, asset_path: String, max_dim: u32, generation: u64) -> (),
                capture_link_preview(url: String).await -> Option<String>,
                capture_meta_fetch(url: String).await -> String,
                capture_oembed_fetch(url: String).await -> String,
                link_preview_fetch_html(url: String).await -> LinkPreviewHtml,
                link_preview_fetch_icon(url: String).await -> String,
                embed_status() -> EmbedStatus,
                embed_ensure().await -> EmbedStatus,
                embed_texts(texts: Vec<String>).await -> Vec<Vec<f32>>,
                watch_start() -> (),
                watch_stop() -> (),
                index_open() -> u64,
                index_apply(note: IndexedNote, generation: u64) -> (),
                index_apply_batch(notes: Vec<IndexedNote>, generation: u64) -> (),
                index_remove(path: String, generation: u64) -> (),
                index_clear(generation: u64) -> (),
                index_move(from: String, to: String, generation: u64, to_address: MovedNoteAddress) -> (),
                index_reconcile_scan(generation: u64).await -> ReconcileScan,
                index_touch(entries: Vec<IndexTouch>, generation: u64) -> (),
                note_move_indexed(request: NoteMoveRequest, generation: u64) -> (),
                index_meta_set(key: String, value: String, generation: u64) -> (),
                db_query(sql: String, params: Vec<serde_json::Value>).await -> Vec<serde_json::Map<String, serde_json::Value>>,
                chat_message_save(conversation: ChatConversation, message: ChatMessageRow, generation: u64) -> (),
                chat_conversation_delete(id: String, generation: u64) -> (),
                embed_apply(path: String, chunks: Vec<EmbeddedChunk>, generation: u64) -> (),
                embed_remove(path: String, generation: u64) -> (),
                git_status(generation: u64).await -> GitStatus,
                git_setup(remote_url: Option<String>, branch: Option<String>, generation: u64).await -> GitStatus,
                git_disconnect(generation: u64).await -> GitStatus,
                git_clone(url: String, path: String, credential: Option<GitCredential>).await -> (),
                git_commit_all(message: String, generation: u64).await -> CommitOutcome,
                git_fetch(credential: Option<GitCredential>, generation: u64).await -> RemoteDelta,
                git_remote_head(url: Option<String>, credential: Option<GitCredential>, generation: u64).await -> RemoteTip,
                git_pull(message: String, generation: u64).await -> PullOutcome,
                git_push(credential: Option<GitCredential>, generation: u64).await -> PushOutcome,
                graph_create(path: String) -> GraphInfo,
                graph_import_reflect_v1_zip(path: String, generation: u64).await -> GraphImportSummary,
                graph_import_cancel() infallible -> (),
                graph_open(path: String) -> GraphInfo,
                graph_delete(generation: u64) -> (),
                note_read(path: String, generation: Option<u64>).await -> String,
                note_read_local(path: String, generation: Option<u64>).await -> LocalNoteRead,
                note_write(path: String, contents: String, generation: u64, check_contents: Option<bool>, expected_contents: Option<String>) -> NoteWriteOutcome,
                note_create(path: String, contents: String, generation: u64) -> NoteCreateOutcome,
                note_exists(path: String) -> bool,
                note_delete(path: String, generation: u64) -> (),
                asset_write(path: String, contents_base64: String, generation: u64) -> (),
                asset_read(path: String, generation: u64) -> String,
                asset_open(path: String, generation: u64) -> (),
                asset_reveal(path: String, generation: u64) -> (),
                audio_memo_delete(path: String, generation: u64) -> (),
                transcript_cache_read(name: String, generation: u64) -> String,
                transcript_cache_write(name: String, contents: String, generation: u64) -> (),
                dir_list(dir: String, generation: u64) -> Vec<FileMeta>,
                list_files(generation: Option<u64>).await -> Vec<FileMeta>,
                list_attachments(generation: Option<u64>).await -> Vec<FileMeta>,
                vault_scan_stats(generation: Option<u64>) -> VaultScanStats,
                asset_upload_begin(generation: u64) -> String,
                asset_upload_commit(id: String, desired_name: String, generation: u64) -> String,
                asset_upload_commit_path(id: String, path: String, generation: u64) -> (),
                asset_upload_abort(id: String) -> (),
                asset_import(source_path: String, desired_name: String, generation: u64).await -> String,
                audio_memo_import(source_path: String, path: String, generation: u64).await -> (),
                x_archive_write(generation: u64, value: serde_json::Value).await -> (),
                x_archive_resolve(generation: u64, post_id: String).await -> Option<serde_json::Value>,
                x_archive_owners(asset_path: String, generation: Option<u64>).await -> Vec<String>,
                x_syndication_fetch(post_id: String).await -> Option<serde_json::Value>,
            }
            desktop {
                skill::skill_status() -> AgentSkillStatus,
                skill::skill_install(generation: u64) -> AgentSkillStatus,
                skill::skill_uninstall(generation: u64) -> AgentSkillStatus,
                menu::menu_install_paste_and_match_style() -> (),
                quit::quit_confirm() -> (),
                windows::open_note_window(deep_link: String) -> (),
                windows::window_bootstrap() -> WindowBootstrap,
                windows::close_note_windows() -> (),
                devtools::toggle_devtools() -> (),
                calendar::calendar_authorization_status() -> CalendarAuthorizationStatus,
                calendar::calendar_request_access() -> bool,
                calendar::calendar_list_calendars() -> Vec<CalendarInfo>,
                calendar::calendar_list_events(start: f64, end: f64, calendar_ids: Vec<String>) -> Vec<CalendarEvent>,
            }
            shell {
                "plugin:recording|start_recording" => recording_start(RecordingStartArgs) -> RecordingSessionStart,
                "plugin:recording|stop_recording" => recording_stop(NoArgs) -> RecordingStopResponse,
                "plugin:recording|cancel_recording" => recording_cancel(NoArgs) -> (),
                "plugin:recording|recording_status" => recording_status(NoArgs) -> RecordingStatus,
                "plugin:recording|list_staged" => recording_list_staged(NoArgs) -> StagedRecordingList,
                "plugin:recording|delete_staged" => recording_delete_staged(RecordingDeleteStagedArgs) -> (),
                "plugin:recording|actions_ready" => recording_actions_ready(NoArgs) -> (),
                "plugin:recording|action_performed" => recording_action_performed(NoArgs) -> (),
                "plugin:web-auth|start" => web_auth_start(WebAuthStartArgs) -> WebAuthCallback,
                "plugin:mobile-haptics|impact_light" => haptics_impact_light(NoArgs) -> (),
                "plugin:app-store|get_environment" => app_store_get_environment(NoArgs) -> AppStoreEnvironmentReply,
                "plugin:app-store|sync" => app_store_sync(NoArgs) -> (),
                "plugin:app-store|present_offer_code_redeem_sheet" => app_store_present_offer_code_redeem_sheet(NoArgs) -> (),
                "plugin:app-store|request_review" => app_store_request_review(NoArgs) -> (),
                "plugin:iap|get_products" => iap_get_products(IapProductsArgs) -> IapProducts,
                "plugin:iap|purchase" => iap_purchase(IapProductArgs) -> (),
                "plugin:iap|get_product_status" => iap_get_product_status(IapProductArgs) -> IapProductStatus,
                "host.log" => host_log(HostLogArgs) -> (),
                "host.open_url" => host_open_url(HostOpenUrlArgs) -> (),
            }
        }
    };
}

/// Defines one module per command with its `Args`, and the `Commands`
/// manifest the codegen exports.
macro_rules! define_commands {
    (
        core { $( $method:ident ( $( $arg:ident : $ty:ty ),* ) $( . $await:tt )? $( $infallible:ident )? -> $ret:ty ),* $(,)? }
        desktop { $( $module:ident :: $desktop:ident ( $( $desktop_arg:ident : $desktop_ty:ty ),* ) -> $desktop_ret:ty ),* $(,)? }
        shell { $( $name:literal => $shell:ident ( $shell_args:ty ) -> $shell_ret:ty ),* $(,)? }
    ) => {
        $( define_commands!(@one $method ( $( $arg : $ty ),* ) -> $ret); )*
        $( define_commands!(@one $desktop ( $( $desktop_arg : $desktop_ty ),* ) -> $desktop_ret); )*
        $( define_commands!(@shell $shell ( $shell_args ) -> $shell_ret); )*

        /// Registers the argument and result types of every command.
        #[cfg(feature = "codegen")]
        pub fn register(types: specta::Types) -> specta::Types {
            types
                $( .register::<$method::Signature>() )*
                $( .register::<$desktop::Signature>() )*
                $( .register::<$shell::Signature>() )*
        }

        /// Every command with its arguments and result. A Swift shell command
        /// field is named after its identifier; the codegen renames it after
        /// the command (`SHELL_COMMANDS`).
        #[cfg(feature = "codegen")]
        #[derive(specta::Type)]
        pub struct Commands {
            $( pub $method: $method::Signature, )*
            $( pub $desktop: $desktop::Signature, )*
            $( pub $shell: $shell::Signature, )*
        }

        /// The identifier and the name of every Swift shell command.
        #[cfg(feature = "codegen")]
        pub const SHELL_COMMANDS: &[(&str, &str)] = &[$( (stringify!($shell), $name) ),*];
    };
    (@shell $shell:ident ( $args:ty ) -> $ret:ty) => {
        #[allow(non_camel_case_types)]
        pub mod $shell {
            #[allow(unused_imports)]
            use super::*;

            define_commands!(@signature $args, $ret);
        }
    };
    (@signature $args:ty, $ret:ty) => {
        /// The command's arguments and result.
        #[cfg(feature = "codegen")]
        #[derive(specta::Type)]
        #[specta(inline)]
        pub struct Signature {
            pub args: $args,
            pub result: $ret,
        }
    };
    (@one $method:ident ( $( $arg:ident : $ty:ty ),* ) -> $ret:ty) => {
        #[allow(non_camel_case_types)]
        pub mod $method {
            #[allow(unused_imports)]
            use super::*;

            /// The command's arguments.
            #[derive(serde::Deserialize)]
            #[cfg_attr(feature = "codegen", derive(specta::Type), specta(inline))]
            #[serde(rename_all = "camelCase")]
            pub struct Args {
                $( pub $arg: $ty, )*
            }

            /// The command's result.
            pub type Result = $ret;

            define_commands!(@signature Args, $ret);
        }
    };
}

commands!(define_commands);

/// The arguments of `asset_read_binary`, a command with a binary reply. The
/// table holds JSON commands only.
#[derive(serde::Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AssetReadBinaryArgs {
    pub path: String,
    pub generation: u64,
}
