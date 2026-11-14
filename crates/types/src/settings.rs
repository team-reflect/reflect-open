//! The settings document.

use serde_json::{Map, Value};

/// The settings document: a JSON object keyed by setting name. `Map` (not
/// `Value`) so a non-object payload is rejected at deserialization.
pub type SettingsDoc = Map<String, Value>;
