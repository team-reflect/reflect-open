use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// The page to open, usually an OAuth authorize URL.
    pub url: String,
    /// The URL scheme (without `://`) whose navigation ends the session, e.g. `reflect`.
    pub callback_scheme: String,
    /// When true, the session shares no cookies or website data with the system browser.
    pub ephemeral: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StartResponse {
    /// The full callback URL including its query, or `None` when the user cancelled.
    pub url: Option<String>,
}
