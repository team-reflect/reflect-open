//! The agent skill command results.

use serde::Serialize;

/// Where the installed skill file stands relative to what this app would
/// write today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum AgentSkillInstallState {
    /// No file at the target path.
    Missing,
    /// Byte-identical to what we would write.
    Current,
    /// Ours (marker present) but rendered from older inputs — a template
    /// change, an app move, or a graph rename/move. Safe to rewrite.
    Stale,
    /// A file we don't manage: no marker, or marker with edited content.
    /// Never overwritten, never deleted.
    Conflict,
}

/// Answer for the settings card: where the skill goes, what it's called, and
/// whether the file on disk is ours.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillStatus {
    pub skill_name: String,
    pub skill_path: String,
    pub cli_path: String,
    pub install_state: AgentSkillInstallState,
}
