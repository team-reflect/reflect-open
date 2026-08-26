use serde::{Deserialize, Serialize};

/// Options for `start_recording`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// Rotate the recorder after this much audio; each segment lands as its
    /// own complete file, so a session has no length limit.
    pub segment_ms: f64,
}

/// `start_recording`'s response: the identity every segment of the session
/// shares, so the webview files them under one memo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    /// The session's start time in epoch milliseconds.
    pub session_started_ms: f64,
}

/// A session's final segment, still in the plugin's staging directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResponse {
    /// Absolute path of the staged `.m4a`, already `-end`-marked.
    pub path: String,
    /// The session's start time in epoch milliseconds: the memo's identity
    /// timestamp, shared by every segment of the recording.
    pub session_started_ms: f64,
    /// 1-based position of this final segment within the session.
    pub part: u32,
    /// The whole session's recorded length in milliseconds.
    pub duration_ms: f64,
}

/// A native action to queue for the webview (the V1 handshake). Sent by the
/// Rust shell when an OS entry point arrives as a URL open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueActionRequest {
    /// Currently only `recordAudio`.
    pub action: String,
}

/// `recording_status`'s response — whether a native recording is live.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatusResponse {
    /// True while a recording is in progress.
    pub recording: bool,
    /// The session's recorded length so far in milliseconds, across every
    /// segment (0 when not recording).
    pub elapsed_ms: f64,
}

/// One file in the staging directory — a segment not yet moved into the
/// graph (an orphan from a crash, or one mid-ingest).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    /// Absolute path of the staged `.m4a`.
    pub path: String,
    /// The session every sibling segment shares, parsed out of the filename.
    pub session_started_ms: f64,
    /// 1-based position within the session.
    pub part: u32,
    /// True on a segment the recorder finalized as its session's last.
    pub end: bool,
    /// Modification time in epoch milliseconds.
    pub modified_ms: f64,
}

/// `list_staged`'s response — every finished recording still in staging.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStagedResponse {
    /// Staged recordings, in no guaranteed order.
    pub files: Vec<StagedFile>,
}

/// `read_staged`'s response — a staged recording's bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadStagedResponse {
    /// The staged file's bytes, base64-encoded.
    pub base64: String,
}

/// Path argument for `read_staged` / `delete_staged`. The native side rejects
/// paths outside its staging directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedPathRequest {
    /// Absolute path of the staged file, as returned by a stop or `list_staged`.
    pub path: String,
}
