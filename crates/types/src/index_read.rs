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

/// The content hash and model of one stored embedding chunk.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ChunkHash {
    pub content_hash: String,
    pub model_id: String,
}

/// One row of the All Notes list.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NoteListEntry {
    pub path: String,
    pub title: String,
    /// The indexed row preview; may be empty.
    pub snippet: String,
    /// The display casing of each tag, ordered by tag key.
    pub tags: Vec<String>,
    /// File modification time (epoch ms).
    pub mtime: i64,
    pub is_pinned: bool,
}

/// One recently changed note.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RecentNoteRow {
    pub path: String,
    pub title: String,
    /// The indexed row preview; may be empty.
    pub preview: String,
    /// File modification time (epoch ms).
    pub mtime: i64,
    pub is_private: bool,
}

/// One task row with the fields of its note that the task list shows.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub note_path: String,
    /// The stored address of the task: JSON text that the frontend decodes.
    pub ast_path: String,
    pub markdown: String,
    /// The stored breadcrumbs: JSON text that the frontend decodes.
    pub breadcrumbs: String,
    pub checked: bool,
    pub note_title: String,
    pub daily_date: Option<String>,
    pub is_pinned: bool,
    /// The explicit `pinned: <n>` order of the note.
    pub pinned_order: Option<f64>,
    /// When the note's row last changed (epoch ms).
    pub updated_at: i64,
}

/// The notes that claim a wiki key in its strongest tier.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WikiClaimMatch {
    /// The strongest tier that claims the key; a lower number is stronger.
    pub tier: i64,
    /// Every note that claims the key in that tier, by path.
    pub paths: Vec<String>,
}

/// One note as a wiki link suggestion candidate, found by its title.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WikiTitleCandidate {
    pub path: String,
    pub title: String,
    pub title_key: String,
    pub daily_date: Option<String>,
    /// File modification time (epoch ms).
    pub mtime: i64,
    /// The number of links that point at a key the note claims.
    pub link_count: u32,
}

/// One link that points at a note.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub source_path: String,
    /// The link target as written.
    pub target_raw: String,
    pub alias: Option<String>,
    /// The UTF-16 offsets of the link in the source body.
    pub pos_from: i64,
    pub pos_to: i64,
}

/// The position after one source in a backlink listing.
#[derive(Clone, Debug, serde::Deserialize, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct BacklinkSourceCursor {
    /// The recency of the source: its daily date, else its last change (epoch ms).
    pub recency_ms: i64,
    pub source_path: String,
}

/// One source note of a backlink page.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct BacklinkSource {
    pub source_path: String,
    pub source_title: String,
    /// The start offset of each link to the target, ascending.
    pub positions: Vec<i64>,
}

/// One page of the sources that link to a note, most recent first.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct BacklinkPage {
    pub sources: Vec<BacklinkSource>,
    /// Where the next page starts; `None` on the last page.
    pub next_cursor: Option<BacklinkSourceCursor>,
    /// The number of links to the target, over all pages.
    pub indexed_link_count: u32,
    /// Every wiki key that resolves to the target.
    pub target_keys: Vec<String>,
}

/// One note as a wiki link suggestion candidate, found by an alias.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WikiAliasCandidate {
    pub path: String,
    pub title: String,
    pub title_key: String,
    pub daily_date: Option<String>,
    /// File modification time (epoch ms).
    pub mtime: i64,
    pub alias: String,
    pub alias_key: String,
    /// The number of links that point at a key the note claims.
    pub link_count: u32,
}

/// The notes that a wiki link query can suggest, before ranking.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WikiCandidates {
    pub titles: Vec<WikiTitleCandidate>,
    pub aliases: Vec<WikiAliasCandidate>,
}

/// The note that wins one wiki key.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WikiKeyWinner {
    pub key: String,
    pub path: String,
    pub daily_date: Option<String>,
    /// The number of notes that claim the key in the winning tier.
    pub claim_count: i64,
}

/// One alias that resolves to its own note and to no other.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WikiWinningAlias {
    pub note_path: String,
    pub alias: String,
}

/// One embedding chunk near a query vector.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ChunkHit {
    /// The path of the note that holds the chunk.
    pub path: String,
    pub title: String,
    pub heading: Option<String>,
    pub text: String,
    pub is_private: bool,
    /// The cosine distance to the query vector; 0 is identical.
    pub distance: f64,
}

/// The `private` flag of one indexed note.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct NotePrivacy {
    pub path: String,
    pub is_private: bool,
}

/// One search over the notes: free text plus filters.
#[derive(Debug, Default, serde::Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    /// The free text as typed; empty for a filter-only search.
    pub text: String,
    /// The folded key of `text`, for title recall.
    pub title_key: String,
    /// The folded keys of the tags a note must all carry.
    pub tag_keys: Vec<String>,
    /// Only daily notes.
    pub daily_only: bool,
    /// Only non-daily notes.
    pub notes_only: bool,
    /// Only pinned notes.
    pub pinned_only: bool,
    /// Only notes with a link to this path.
    pub links_to_path: Option<String>,
    /// Only notes that this path links to.
    pub linked_from_path: Option<String>,
    /// Only notes changed at or after this time (epoch ms).
    pub updated_after_ms: Option<f64>,
    /// Only notes changed before this time (epoch ms).
    pub updated_before_ms: Option<f64>,
    /// Lists pinned notes first when there is no free text.
    pub pinned_first: bool,
    /// The most hits to return; `None` returns all.
    pub limit: Option<u32>,
}

/// One search hit, before the frontend derives its display fields.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SearchHitRow {
    pub path: String,
    pub title: String,
    pub daily_date: Option<String>,
    /// The indexed row preview; may be empty.
    pub preview: String,
    /// File modification time (epoch ms).
    pub mtime: i64,
    pub is_pinned: bool,
    /// The title with FTS5 highlight markers, when the search index matched.
    pub fts_highlighted_title: Option<String>,
    /// The FTS5 body snippet, when the search index matched.
    pub snippet: Option<String>,
}
