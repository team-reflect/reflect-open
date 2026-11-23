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

/// `tasks`: the tasks, by note path and then in document order, plus the
/// staleness signal.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksJson<'a> {
    /// True when files on disk diverge from the index — tasks may be stale.
    pub stale: bool,
    pub tasks: Vec<TaskJson<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskJson<'a> {
    pub path: &'a str,
    pub title: &'a str,
    /// The daily date of the note, when the note is a daily.
    pub date: Option<&'a str>,
    /// The first paragraph of the task as Markdown, without its marker.
    pub markdown: &'a str,
    pub checked: bool,
    /// The first `[[YYYY-MM-DD]]` link of the task.
    pub due_date: Option<&'a str>,
    /// The headings above the task, then its parent list items, outermost
    /// first, as Markdown.
    pub breadcrumbs: &'a [String],
}
