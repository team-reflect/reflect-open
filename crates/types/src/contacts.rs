//! Contacts command results.

use serde::Serialize;

/// The Contacts permission state, as the settings UI consumes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ContactsAuthorization {
    /// The user has not been asked yet — enabling the toggle should prompt.
    NotDetermined,
    /// Access is blocked by policy (parental controls, MDM); the user cannot
    /// grant it from the app.
    Restricted,
    /// The user said no — point them at System Settings.
    Denied,
    /// Full access granted.
    Authorized,
    /// Partial access (iOS 18+); reads work against the shared subset.
    Limited,
    /// No Contacts framework on this platform.
    Unavailable,
}

/// One matched contact, flattened to the fields Reflect can write into a
/// note as markdown. Photos are deliberately absent (out of v1 scope).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ContactMatch {
    /// Locale-aware display name from `CNContactFormatter` (given/family
    /// ordering differs by locale, so it is not composed by hand).
    pub full_name: String,
    pub given_name: String,
    pub family_name: String,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
}
