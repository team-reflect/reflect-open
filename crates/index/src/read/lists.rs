//! The note lists: the All Notes list, recent notes and tag facets.

use std::collections::HashMap;

use rusqlite::{Connection, Row, params};

use reflect_types::{AppResult, NoteListEntry, RecentNoteRow, TagFacet};

/// The recall-feed order: pins first (an explicit order before unordered
/// pins), then recency, with the path as the stable tiebreak.
pub(crate) const PINNED_FIRST_ORDER: &str = "notes.is_pinned DESC, notes.pinned_order IS NULL, notes.pinned_order, notes.mtime DESC, notes.path";

/// The recall-feed order without pins: recency, then the path.
pub(crate) const RECENT_ORDER: &str = "notes.mtime DESC, notes.path";

fn list_entry(row: &Row<'_>) -> rusqlite::Result<NoteListEntry> {
    Ok(NoteListEntry {
        path: row.get(0)?,
        title: row.get(1)?,
        mtime: row.get(2)?,
        snippet: row.get(3)?,
        is_pinned: row.get(4)?,
        tags: Vec::new(),
    })
}

/// The All Notes list. Without a tag it holds every non-daily note; with one
/// it holds the notes and the daily notes that carry the tag.
pub(crate) fn list_notes(
    conn: &Connection,
    tag_key: Option<&str>,
) -> AppResult<Vec<NoteListEntry>> {
    let mut entries: Vec<NoteListEntry> = match tag_key {
        None => conn
            .prepare_cached(&format!(
                "SELECT notes.path, notes.title, notes.mtime, notes.preview, notes.is_pinned
                 FROM notes
                 WHERE notes.kind = 'note'
                 ORDER BY {PINNED_FIRST_ORDER}"
            ))?
            .query_map([], list_entry)?
            .collect::<Result<_, _>>()?,
        Some(tag_key) => conn
            .prepare_cached(&format!(
                "SELECT DISTINCT notes.path, notes.title, notes.mtime, notes.preview,
                        notes.is_pinned, notes.pinned_order
                 FROM tags
                 JOIN notes ON notes.path = tags.note_path
                 WHERE tags.tag_key = ?1 AND notes.kind IN ('note', 'daily')
                 ORDER BY {PINNED_FIRST_ORDER}"
            ))?
            .query_map([tag_key], list_entry)?
            .collect::<Result<_, _>>()?,
    };
    if entries.is_empty() {
        return Ok(entries);
    }

    // The tags of the same note set, through the same predicates. The folded
    // key orders them like the facet list, whatever the display casing.
    let tags: Vec<(String, String)> = match tag_key {
        None => conn
            .prepare_cached(
                "SELECT tags.note_path, tags.tag FROM tags
                 JOIN notes ON notes.path = tags.note_path
                 WHERE notes.kind = 'note'
                 ORDER BY tags.tag_key",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?,
        Some(tag_key) => conn
            .prepare_cached(
                "SELECT DISTINCT tags.note_path, tags.tag FROM tags
                 JOIN notes ON notes.path = tags.note_path
                 JOIN tags AS filter_tags ON filter_tags.note_path = notes.path
                 WHERE filter_tags.tag_key = ?1 AND notes.kind IN ('note', 'daily')
                 ORDER BY tags.tag_key",
            )?
            .query_map([tag_key], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?,
    };
    let mut tags_by_path: HashMap<String, Vec<String>> = HashMap::new();
    for (path, tag) in tags {
        tags_by_path.entry(path).or_default().push(tag);
    }
    for entry in &mut entries {
        entry.tags = tags_by_path.remove(&entry.path).unwrap_or_default();
    }
    Ok(entries)
}

fn recent_row(row: &Row<'_>) -> rusqlite::Result<RecentNoteRow> {
    Ok(RecentNoteRow {
        path: row.get(0)?,
        title: row.get(1)?,
        preview: row.get(2)?,
        mtime: row.get(3)?,
        is_private: row.get(4)?,
    })
}

/// The most recently changed non-private notes, at most `limit`, with the tag
/// `tag_key` when one is given.
pub(crate) fn recent_notes(
    conn: &Connection,
    limit: u32,
    tag_key: Option<&str>,
) -> AppResult<Vec<RecentNoteRow>> {
    let rows = match tag_key {
        None => conn
            .prepare_cached(&format!(
                "SELECT notes.path, notes.title, notes.preview, notes.mtime, notes.is_private
                 FROM notes
                 WHERE notes.kind = 'note' AND notes.is_private = 0
                 ORDER BY {RECENT_ORDER}
                 LIMIT ?1"
            ))?
            .query_map([limit], recent_row)?
            .collect::<Result<_, _>>()?,
        Some(tag_key) => conn
            .prepare_cached(&format!(
                "SELECT DISTINCT notes.path, notes.title, notes.preview, notes.mtime,
                        notes.is_private
                 FROM tags
                 JOIN notes ON notes.path = tags.note_path
                 WHERE tags.tag_key = ?1 AND notes.kind = 'note' AND notes.is_private = 0
                 ORDER BY {RECENT_ORDER}
                 LIMIT ?2"
            ))?
            .query_map(params![tag_key, limit], recent_row)?
            .collect::<Result<_, _>>()?,
    };
    Ok(rows)
}

/// The tag facets over non-daily notes, by tag key, each with one display
/// casing.
pub(crate) fn note_tags(conn: &Connection) -> AppResult<Vec<TagFacet>> {
    let facets = conn
        .prepare_cached(
            "SELECT min(tags.tag), count(*) FROM tags
             JOIN notes ON notes.path = tags.note_path
             WHERE notes.kind = 'note'
             GROUP BY tags.tag_key
             ORDER BY tags.tag_key",
        )?
        .query_map([], |row| {
            Ok(TagFacet {
                tag: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(facets)
}
