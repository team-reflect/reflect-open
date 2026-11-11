use serde::{Deserialize, Serialize};

/// UIKit's horizontal size class of the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HorizontalSizeClass {
    /// An iPhone, Slide Over, a narrow Split View pane or a narrow window.
    Compact,
    /// A full-screen iPad or a wide window.
    Regular,
}

/// `size_class`'s response, and the `sizeClassChanged` event's payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeClassPayload {
    pub horizontal: HorizontalSizeClass,
}
