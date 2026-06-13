use serde::{Deserialize, Serialize};

/// The text handed to the OS share sheet, with an optional subject (used by
/// targets that carry one, e.g. Mail).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequest {
    pub text: String,
    pub title: Option<String>,
}
