//! The `--json` output contracts (documented in `docs/cli.md`, locked by the
//! integration tests) plus the human print helpers. Field names are camelCase
//! to match the rest of Reflect's external JSON shapes.

use serde::Serialize;

use crate::error::CliError;

/// `today` / `show`: the note itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteJson<'a> {
    /// The daily date, when the note is a daily.
    pub date: Option<&'a str>,
    pub path: &'a str,
    pub absolute_path: String,
    pub title: &'a str,
    pub content: &'a str,
    /// SHA-256 of the full source; pass it to mutation commands as `--expect-hash`.
    pub hash: String,
}

/// `path` / `today --path`: a resolved location (the file may not exist yet
/// for dailies — they are created lazily on first write).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathJson<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<&'a str>,
    pub path: &'a str,
    pub absolute_path: String,
    pub exists: bool,
}

/// `open`: the deep link handed to the OS opener (or just printed).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenJson<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<&'a str>,
    pub path: &'a str,
    /// The `reflect://` URL (docs/deep-links.md).
    pub url: &'a str,
    /// False under `--print` — the URL was emitted, not handed to the OS.
    pub launched: bool,
}

/// `search`: the ranked hits plus the staleness signal.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchJson<'a> {
    pub query: &'a str,
    /// True when files on disk diverge from the index — results may be stale.
    pub stale: bool,
    pub results: Vec<HitJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HitJson {
    pub path: String,
    pub title: String,
    pub snippet: String,
    /// bm25 rank (more negative = better match); `0` for title-only substring hits.
    pub score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummaryJson {
    pub path: String,
    pub absolute_path: String,
    pub title: String,
    pub kind: String,
    pub mtime: u64,
    pub hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListJson {
    pub results: Vec<NoteSummaryJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkJson {
    pub source_path: String,
    pub source_title: String,
    pub target_raw: String,
    pub alias: Option<String>,
    pub pos_from: i64,
    pub pos_to: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinksJson {
    pub target_path: String,
    pub results: Vec<BacklinkJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskJson {
    pub note_path: String,
    pub note_title: String,
    pub marker_offset: i64,
    pub text: String,
    pub raw: String,
    pub checked: bool,
    pub due_date: Option<String>,
    pub breadcrumbs: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksJson {
    pub results: Vec<TaskJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagJson {
    pub tag: String,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagsJson {
    pub results: Vec<TagJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationJson {
    pub action: &'static str,
    pub path: String,
    pub absolute_path: String,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trash_path: Option<String>,
}

pub fn print_json<T: Serialize>(value: &T) -> Result<(), CliError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|err| CliError::Runtime(format!("could not serialize output: {err}")))?;
    println!("{json}");
    Ok(())
}

/// Print raw note content, normalizing to exactly one trailing newline.
pub fn print_content(content: &str) {
    if content.ends_with('\n') {
        print!("{content}");
    } else {
        println!("{content}");
    }
}
