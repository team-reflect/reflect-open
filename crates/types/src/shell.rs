//! The arguments, results and events of the commands the Swift shell answers
//! (`plugin:<name>|<command>` and `host.<command>`).

use serde::{Deserialize, Serialize};

/// `plugin:recording|start_recording` arguments.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct RecordingStartArgs {
    pub request: StartRecordingOptions,
}

/// How a recording session runs.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingOptions {
    /// Rotate the recorder after this much audio, natively, so rotation holds
    /// even if JS never wakes. Each segment is one staged file.
    pub segment_ms: f64,
    /// Remind the user this often while the session runs. The shell schedules
    /// the notification itself, so it survives a sleeping web view and is
    /// cleared by whatever ends the session.
    pub reminder_ms: f64,
}

/// The identity every segment of a session shares.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSessionStart {
    /// Epoch milliseconds.
    pub session_started_ms: f64,
}

/// A session's final segment, still in staging.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStopResponse {
    /// Absolute path of the staged `.m4a`, already `-end`-marked.
    pub path: String,
    pub session_started_ms: f64,
    /// 1-based position of this final segment.
    pub part: u32,
    /// The whole session's recorded length.
    pub duration_ms: f64,
}

/// Whether a session runs, and its recorded length so far.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub recording: bool,
    /// Across every segment of the session.
    pub elapsed_ms: f64,
}

/// One staged segment file.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StagedRecordingFile {
    /// Absolute path of the staged `.m4a`.
    pub path: String,
    pub session_started_ms: f64,
    /// 1-based position within the session.
    pub part: u32,
    /// True for the final segment of a session.
    pub end: bool,
    pub modified_ms: f64,
}

/// `plugin:recording|list_staged` result.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct StagedRecordingList {
    pub files: Vec<StagedRecordingFile>,
}

/// `plugin:recording|delete_staged` arguments.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct RecordingDeleteStagedArgs {
    pub request: StagedRecordingPath,
}

/// One staged segment file, by its absolute path.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct StagedRecordingPath {
    pub path: String,
}

/// `plugin:recording:recordingLevel`, about 10 times a second while
/// recording in the foreground.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingLevelEvent {
    /// Linear input level from 0 to 1.
    pub level: f32,
    /// Recorded time so far, pauses excluded.
    pub elapsed_ms: f64,
}

/// `plugin:recording:recordingSegment`: a finished segment of a session that
/// still records. The final segment arrives in the stop result or in
/// `recordingStopped`.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSegmentEvent {
    pub path: String,
    pub session_started_ms: f64,
    pub part: u32,
}

/// `plugin:recording:recordingStopped`: the shell ended a session.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStoppedEvent {
    pub path: String,
    pub session_started_ms: f64,
    pub part: u32,
    /// The whole session's recorded length.
    pub duration_ms: f64,
    pub reason: String,
}

/// `plugin:recording:nativeAction`: an OS entry point asked for something
/// only the web view can present.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct RecordingNativeActionEvent {
    /// Currently only `recordAudio`.
    pub action: String,
}

/// `plugin:web-auth|start` arguments.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct WebAuthStartArgs {
    pub payload: WebAuthOptions,
}

/// A system web sign-in.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebAuthOptions {
    /// The page that starts the sign-in.
    pub url: String,
    /// The URL scheme that ends the sign-in.
    pub callback_scheme: String,
    /// When true, the session shares no cookies or website data with the
    /// system browser.
    pub ephemeral: bool,
}

/// `plugin:web-auth|start` result.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct WebAuthCallback {
    /// The callback URL; none when the user cancels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// `plugin:app-store|get_environment` result.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct AppStoreEnvironmentReply {
    /// `Production`, `Sandbox` or `Xcode`.
    pub environment: String,
}

/// The kind of store product.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum IapProductType {
    /// An auto-renewable subscription.
    Subs,
}

/// `plugin:iap|get_products` arguments.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct IapProductsArgs {
    pub payload: IapProductsQuery,
}

/// The products to look up.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IapProductsQuery {
    pub product_ids: Vec<String>,
    pub product_type: IapProductType,
}

/// `plugin:iap|get_products` result.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct IapProducts {
    pub products: Vec<IapProduct>,
}

/// One store product.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IapProduct {
    pub product_id: String,
    /// The store-localized display price, such as `$4.99`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formatted_price: Option<String>,
}

/// `plugin:iap|purchase` and `plugin:iap|get_product_status` arguments.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct IapProductArgs {
    pub payload: IapProductQuery,
}

/// One product.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IapProductQuery {
    pub product_id: String,
    pub product_type: IapProductType,
}

/// `plugin:iap|get_product_status` result.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IapProductStatus {
    /// Whether a verified transaction entitles the user to the product now.
    pub is_owned: bool,
}

/// The severity of a `host.log` line.
#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum HostLogLevel {
    Error,
    Warn,
    Info,
}

/// `host.log` arguments: one line of the web app.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct HostLogArgs {
    pub level: HostLogLevel,
    pub message: String,
}

/// `host.open_url` arguments.
#[derive(Serialize, Deserialize, specta::Type)]
pub struct HostOpenUrlArgs {
    /// An absolute URL.
    pub url: String,
}

/// The arguments of a command that takes none.
#[derive(Default, Serialize, Deserialize, specta::Type)]
pub struct NoArgs {}
