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
