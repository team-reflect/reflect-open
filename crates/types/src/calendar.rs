//! Calendar command results (desktop, EventKit).

use serde::Serialize;

/// The EventKit authorization state for events. Only `FullAccess` lets
/// Reflect read events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum CalendarAuthorizationStatus {
    NotDetermined,
    Restricted,
    Denied,
    FullAccess,
    WriteOnly,
}

/// A calendar known to macOS, across every account the user has added in
/// System Settings → Internet Accounts.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    /// EventKit's stable calendar identifier: what user settings store.
    pub id: String,
    pub title: String,
    /// The owning account's display name ("iCloud", "Google", "On My Mac").
    pub source: String,
    /// Display color as `#rrggbb`, when one could be resolved.
    pub color: Option<String>,
}

/// An attendee's response to an invite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum CalendarAttendeeStatus {
    Accepted,
    Declined,
    Tentative,
    Pending,
    Unknown,
}

/// One attendee of a calendar event.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CalendarAttendee {
    /// Display name, falling back to the address in the participant URL.
    pub name: String,
    /// The invite email, when the participant URL is a `mailto:`: what the
    /// contacts integration resolves person notes by.
    pub email: Option<String>,
    pub is_current_user: bool,
    /// Whether this attendee is a person (as opposed to a room or resource).
    pub is_person: bool,
    pub status: CalendarAttendeeStatus,
}

/// How an event blocks the user's time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum CalendarAvailability {
    Busy,
    Free,
    Tentative,
    Unavailable,
    NotSupported,
}

/// A single event occurrence within a queried date range.
///
/// Occurrences of a recurring event share an `id`; consumers needing a unique
/// key should combine `id` with `starts_at`.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    /// Start/end as Unix epoch milliseconds.
    pub starts_at: f64,
    pub ends_at: f64,
    pub all_day: bool,
    pub recurring: bool,
    pub availability: CalendarAvailability,
    pub canceled: bool,
    pub attendees: Vec<CalendarAttendee>,
}
