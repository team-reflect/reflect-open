//! The capture inbox contract: the envelopes every producer spools, the
//! extension's wire message and ack, the files the app writes for the
//! producers, and the names and limits they share.
//!
//! The TypeScript drain validates inbox files with the zod schemas in
//! `packages/core/src/capture/`, which check these types.

use serde::{Deserialize, Serialize};

/// The Info.plist key that names the flavor's App Group, in the app and in
/// each extension.
pub const APP_GROUP_KEY: &str = "ReflectAppGroup";
/// The spool directory inside the App Group container.
pub const SHARED_INBOX_DIR: &str = "inbox";
/// The largest envelope the relay copies out of the App Group container.
pub const SHARED_ENVELOPE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// The largest screenshot the relay copies out of the App Group container.
pub const SHARED_SCREENSHOT_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// The largest envelope the app and the iOS producers spool themselves: one
/// short link or line.
pub const INBOX_SPOOL_MAX_BYTES: u64 = 64 * 1024;
/// The quick note defaults file inside the App Group container.
pub const QUICK_NOTE_DEFAULTS_FILE: &str = "quick-note.json";
/// The graph-relative inbox the drain reads.
pub const GRAPH_INBOX_DIR: &str = ".reflect/inbox";
/// The pointer file, under the OS config directory.
pub const CAPTURE_POINTER_PATH: [&str; 2] = ["reflect-open", "capture-pointer.json"];

/// Who produced a link capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum CaptureSource {
    Extension,
    IosShare,
}

/// A captured web page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LinkCaptureEnvelope {
    /// Always 1.
    pub version: u32,
    /// A UUID; it names the spool files.
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_text: Option<String>,
    /// In-page meta description; only the iOS share extension sets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The screenshot file beside the envelope. The spooler sets it; the
    /// extension never sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_ref: Option<String>,
    /// ISO-8601 with an offset.
    pub captured_at: String,
    pub source: CaptureSource,
}

/// The browser extension's message to the native host: an envelope and an
/// optional screenshot.
#[derive(Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CaptureWireMessage {
    pub envelope: LinkCaptureEnvelope,
    /// Standard base64 JPEG bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_base64: Option<String>,
}

/// Where a text capture lands in the daily note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TextCaptureKind {
    Append,
    Checkbox,
    Task,
}

/// Who produced a text capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum TextCaptureSource {
    DeepLink,
    IosShare,
    IosIntent,
}

/// Captured text: one folded line the drain writes into the capture day's
/// daily note.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TextCaptureEnvelope {
    /// Always 1.
    pub version: u32,
    /// A UUID; it names the spool file.
    pub id: String,
    pub kind: TextCaptureKind,
    pub text: String,
    /// The top-level bullet the entry nests under; none appends at the end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// ISO-8601 with an offset.
    pub captured_at: String,
    pub source: TextCaptureSource,
}

/// Why a capture was not spooled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "kebab-case")]
pub enum CaptureErrorCode {
    /// The app has never opened a graph on this machine.
    NoGraph,
    InvalidPayload,
    Io,
    /// The app that owns the graph cannot read this envelope version yet.
    UnsupportedVersion,
}

/// The native host's answer to one wire message: `{ ok: true, status:
/// "queued" }`, or `{ ok: false, code, message }`.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CaptureAck {
    pub ok: bool,
    /// Always `"queued"` when `ok`: the host never sees the drain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<CaptureErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl CaptureAck {
    /// The success ack.
    pub fn queued() -> Self {
        Self {
            ok: true,
            status: Some("queued".to_owned()),
            code: None,
            message: None,
        }
    }

    /// A failure ack.
    pub fn failed(code: CaptureErrorCode, message: String) -> Self {
        Self {
            ok: false,
            status: None,
            code: Some(code),
            message: Some(message),
        }
    }
}

/// The file the desktop app writes so the native host can find the open
/// graph.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CapturePointer {
    /// Always 1.
    pub version: u32,
    pub graph_root: String,
    /// The X bookmark envelope version the app reads.
    pub bookmark_version: Option<u32>,
    /// The X like envelope version the app reads; none when it reads none.
    pub x_like_version: Option<u32>,
}

/// The quick note defaults the app mirrors into the App Group container
/// for the iOS App Intent.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct QuickNoteDefaultsFile {
    /// Always 1.
    pub version: u32,
    /// The bullet new entries nest under.
    pub parent: String,
}
