//! The link preview page fetch result.

use serde::Serialize;

#[derive(Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LinkPreviewHtml {
    pub html: String,
    pub final_url: String,
}
