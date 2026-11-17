//! The results of the index read commands.

use serde::Serialize;

/// One tag with the number of notes that carry it.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TagFacet {
    /// One display casing of the tag.
    pub tag: String,
    pub count: u32,
}

/// The aggregates of one graph, private notes excluded throughout.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct GraphStats {
    /// Non-daily notes.
    pub note_count: u32,
    /// Days with a daily note.
    pub daily_note_count: u32,
    /// ISO date of the first daily note.
    pub earliest_daily_date: Option<String>,
    /// ISO date of the latest daily note.
    pub latest_daily_date: Option<String>,
    /// Tag facets over non-daily notes, most-used first, then by tag key.
    pub tags: Vec<TagFacet>,
    /// More tags exist than the requested limit.
    pub tags_truncated: bool,
}

/// One daily note, as a listing shows it.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DailyNoteRow {
    pub path: String,
    pub title: String,
    pub daily_date: String,
    /// The indexed row preview; may be empty.
    pub preview: String,
    /// File modification time (epoch ms).
    pub mtime: i64,
    pub is_private: bool,
}

/// The core fields of one note row.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    pub path: String,
    pub title: String,
    pub daily_date: Option<String>,
    /// The `private: true` frontmatter flag.
    pub is_private: bool,
    /// The html url of the published gist.
    pub gist_url: Option<String>,
    /// The body changed since it was last published.
    pub gist_stale: bool,
}

/// One pinned note.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PinnedNoteRow {
    pub path: String,
    pub title: String,
    pub daily_date: Option<String>,
    /// The explicit `pinned: <n>` order.
    pub pinned_order: Option<f64>,
}

/// One template.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TemplateEntry {
    pub path: String,
    pub title: String,
    /// File modification time (epoch ms).
    pub mtime: i64,
}

/// The stored hash and modification time of one indexed note.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteFileFacts {
    pub path: String,
    pub file_hash: String,
    /// File modification time (epoch ms).
    pub mtime: i64,
}

/// The frontmatter `id` of one indexed note.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteId {
    pub path: String,
    pub id: Option<String>,
}
