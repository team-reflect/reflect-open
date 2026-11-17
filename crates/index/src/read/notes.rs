//! Row lookups over the `notes` and `aliases` tables.

use rusqlite::{Connection, OptionalExtension, params};

use reflect_types::{
    AppResult, NoteFileFacts, NoteId, NotePrivacy, NoteRow, PinnedNoteRow, TemplateEntry,
};

/// A list of text values as one bound parameter, for
/// `IN (SELECT value FROM json_each(?))`.
pub(crate) fn json_list(values: &[String]) -> AppResult<String> {
    serde_json::to_string(values).map_err(|err| reflect_types::AppError::io(err.to_string()))
}

/// The row of the note at `path`.
pub(crate) fn note(conn: &Connection, path: &str) -> AppResult<Option<NoteRow>> {
    Ok(conn
        .prepare_cached(
            "SELECT path, title, daily_date, is_private, gist_url, gist_stale FROM notes
             WHERE path = ?1",
        )?
        .query_row([path], |row| {
            Ok(NoteRow {
                path: row.get(0)?,
                title: row.get(1)?,
                daily_date: row.get(2)?,
                is_private: row.get(3)?,
                gist_url: row.get(4)?,
                gist_stale: row.get(5)?,
            })
        })
        .optional()?)
}

/// Every pinned note, in shelf order: an explicit order first (ascending),
/// then by folded title, with the path as the tiebreak.
pub(crate) fn pinned_notes(conn: &Connection) -> AppResult<Vec<PinnedNoteRow>> {
    let notes = conn
        .prepare_cached(
            "SELECT path, title, daily_date, pinned_order FROM notes
             WHERE is_pinned = 1 AND kind != 'template'
             ORDER BY pinned_order IS NULL, pinned_order, title_key, path",
        )?
        .query_map([], |row| {
            Ok(PinnedNoteRow {
                path: row.get(0)?,
                title: row.get(1)?,
                daily_date: row.get(2)?,
                pinned_order: row.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(notes)
}

/// Every template, by folded title, with the path as the tiebreak.
pub(crate) fn templates(conn: &Connection) -> AppResult<Vec<TemplateEntry>> {
    let templates = conn
        .prepare_cached(
            "SELECT path, title, mtime FROM notes
             WHERE kind = 'template'
             ORDER BY title_key, path",
        )?
        .query_map([], |row| {
            Ok(TemplateEntry {
                path: row.get(0)?,
                title: row.get(1)?,
                mtime: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(templates)
}

/// The stored hash and mtime of each indexed path in `paths`.
pub(crate) fn file_facts(conn: &Connection, paths: &[String]) -> AppResult<Vec<NoteFileFacts>> {
    let facts = conn
        .prepare_cached(
            "SELECT path, file_hash, mtime FROM notes
             WHERE path IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([json_list(paths)?], |row| {
            Ok(NoteFileFacts {
                path: row.get(0)?,
                file_hash: row.get(1)?,
                mtime: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(facts)
}

/// The frontmatter `id` of each indexed path in `paths`.
pub(crate) fn note_ids(conn: &Connection, paths: &[String]) -> AppResult<Vec<NoteId>> {
    let ids = conn
        .prepare_cached(
            "SELECT path, id FROM notes WHERE path IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([json_list(paths)?], |row| {
            Ok(NoteId {
                path: row.get(0)?,
                id: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

/// The path of a uniformly random note.
pub(crate) fn random_note(conn: &Connection) -> AppResult<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT path FROM notes ORDER BY random() LIMIT 1")?
        .query_row([], |row| row.get(0))
        .optional()?)
}

/// Resolves a free-form note target to a path. The first match wins: a
/// frontmatter `id`, then `daily_path` (set when the target is an ISO date),
/// an exact path, a title with the folded `key`, an alias with `key`.
pub(crate) fn resolve_target(
    conn: &Connection,
    target: &str,
    daily_path: Option<String>,
    key: &str,
) -> AppResult<Option<String>> {
    let first = |sql: &str, value: &str| -> AppResult<Option<String>> {
        Ok(conn
            .prepare_cached(sql)?
            .query_row(params![value], |row| row.get(0))
            .optional()?)
    };
    if let Some(path) = first(
        "SELECT path FROM notes WHERE id = ?1 ORDER BY path LIMIT 1",
        target,
    )? {
        return Ok(Some(path));
    }
    if daily_path.is_some() {
        return Ok(daily_path);
    }
    if let Some(path) = first("SELECT path FROM notes WHERE path = ?1", target)? {
        return Ok(Some(path));
    }
    if let Some(path) = first(
        "SELECT path FROM notes WHERE title_key = ?1 ORDER BY path LIMIT 1",
        key,
    )? {
        return Ok(Some(path));
    }
    first(
        "SELECT note_path FROM aliases WHERE alias_key = ?1 ORDER BY note_path LIMIT 1",
        key,
    )
}

/// Whether a note is indexed at `path`.
pub(crate) fn path_taken(conn: &Connection, path: &str) -> AppResult<bool> {
    Ok(conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM notes WHERE path = ?1)")?
        .query_row([path], |row| row.get(0))?)
}

/// The notes with the tag `tag_key` that carry any of `email_keys`, by path.
pub(crate) fn person_owners(
    conn: &Connection,
    email_keys: &[String],
    tag_key: &str,
) -> AppResult<Vec<String>> {
    let paths = conn
        .prepare_cached(
            "SELECT DISTINCT notes.path FROM note_emails
             JOIN notes ON notes.path = note_emails.note_path
             JOIN tags ON tags.note_path = notes.path
             WHERE note_emails.email_key IN (SELECT value FROM json_each(?1))
               AND tags.tag_key = ?2
               AND notes.kind = 'note'
             ORDER BY notes.path",
        )?
        .query_map(params![json_list(email_keys)?, tag_key], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(paths)
}

/// The path of every note that gets embeddings, ascending: all but templates.
pub(crate) fn embeddable_paths(conn: &Connection) -> AppResult<Vec<String>> {
    let paths = conn
        .prepare_cached("SELECT path FROM notes WHERE kind != 'template' ORDER BY path")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(paths)
}

/// The `private` flag of each indexed path in `paths`.
pub(crate) fn privacy(conn: &Connection, paths: &[String]) -> AppResult<Vec<NotePrivacy>> {
    let flags = conn
        .prepare_cached(
            "SELECT path, is_private FROM notes WHERE path IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([json_list(paths)?], |row| {
            Ok(NotePrivacy {
                path: row.get(0)?,
                is_private: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(flags)
}
