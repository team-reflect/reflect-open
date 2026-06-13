use serde::{Deserialize, Serialize};

/// The keyboard's current relationship to the webview — also the payload of
/// the plugin's `keyboardChange` event.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardState {
    /// Points of webview height the keyboard currently covers (0 = hidden).
    pub height: f64,
    /// The keyboard's animation duration in seconds.
    pub duration: f64,
}
