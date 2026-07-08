//! The index write path: note projections in, rows out.
//!
//! The TS↔Rust payload contract lives here ([`IndexedNote`]); all mutations are
//! plain functions over a [`Connection`] so the command layer ([`super`]) owns
//! transactions and generation gating while these stay directly unit-testable.

use rusqlite::{params, Connection};
use serde::Deserialize;

use crate::error::AppResult;

/// A note's extracted projection, built in TS (Plan 03) and applied as one
/// row-set. Mirrors the `indexedNoteSchema` zod contract in
/// `packages/core/src/indexing/indexed-note.ts` field-for-field (serde
/// `rename_all = "camelCase"` matches the camelCase payload); a change on either
/// side must be mirrored on the other.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedNote {
    pub(super) path: String,
    pub(super) id: Option<String>,
    pub(super) title: String,
    pub(super) title_key: String,
    /// 'daily' | 'note' | 'template' — templates are excluded from note surfaces.
    pub(super) kind: String,
    pub(super) daily_date: Option<String>,
    pub(super) is_private: bool,
    pub(super) is_pinned: bool,
    pub(super) pinned_order: Option<f64>,
    /// The file carries Git conflict markers (sync merge, Plan 12).
    pub(super) has_conflict: bool,
    /// The published GitHub Gist's html url, when the note has one.
    pub(super) gist_url: Option<String>,
    /// The body changed since it was last published to the gist.
    pub(super) gist_stale: bool,
    pub(super) file_hash: String,
    pub(super) mtime: i64,
    pub(super) text: String,
    /// Description text of referenced assets (Plan 20), folded into the FTS
    /// `body` only — never `note_text`, `preview`, or anything AI-reachable.
    #[serde(default)]
    pub(super) asset_text: String,
    pub(super) preview: String,
    pub(super) links: Vec<IndexedLink>,
    pub(super) tags: Vec<IndexedTag>,
    pub(super) aliases: Vec<IndexedAlias>,
    /// Emails the note owns via `- Email:` contact-field bullets.
    pub(super) emails: Vec<IndexedEmail>,
    pub(super) assets: Vec<String>,
    pub(super) tasks: Vec<IndexedTask>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexedLink {
    pub(super) kind: String,
    pub(super) target_raw: String,
    pub(super) target_key: String,
    pub(super) alias: Option<String>,
    pub(super) pos_from: i64,
    pub(super) pos_to: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexedTag {
    pub(super) tag: String,
    pub(super) tag_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexedAlias {
    pub(super) alias: String,
    pub(super) alias_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexedEmail {
    pub(super) email: String,
    pub(super) email_key: String,
}

/// One GFM checkbox (Plan 18). `marker_offset` is the `[`'s character offset in
/// the file (UTF-16 units) and, with `note_path`, the row's primary key.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexedTask {
    pub(super) marker_offset: i64,
    pub(super) text: String,
    /// Parent outline/list item text, top-down, displayed in the Tasks view.
    #[serde(default)]
    pub(super) breadcrumbs: Vec<String>,
    pub(super) raw: String,
    pub(super) checked: bool,
    /// Explicit due date (first `[[YYYY-MM-DD]]` in the item), or None.
    pub(super) due_date: Option<String>,
}

/// Replace all rows for `note.path` with its current projection. Caller wraps
/// this in a transaction; statements are cached so a batch rebuild reuses them.
///
/// We clear the note via `remove_note` (which deletes the `notes` row and lets
/// `ON DELETE CASCADE` clear every child table) and then insert fresh rows.
/// The schema's foreign keys — not a hand-maintained `DELETE` list here — are the
/// single source of truth for what belongs to a note, so new child tables (Plan
/// 09 embeddings, etc.) need no change to this function.
pub(super) fn apply_note(conn: &Connection, note: &IndexedNote) -> AppResult<()> {
    remove_note(conn, &note.path)?;

    conn.prepare_cached(
        "INSERT INTO notes(path, id, title, title_key, kind, daily_date, is_private, is_pinned, pinned_order, has_conflict, gist_url, gist_stale, file_hash, mtime, updated_at, preview)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15)",
    )?
    .execute(params![
        note.path,
        note.id,
        note.title,
        note.title_key,
        note.kind,
        note.daily_date,
        i64::from(note.is_private),
        i64::from(note.is_pinned),
        note.pinned_order,
        i64::from(note.has_conflict),
        note.gist_url,
        i64::from(note.gist_stale),
        note.file_hash,
        note.mtime,
        note.preview,
    ])?;
    conn.prepare_cached("INSERT INTO note_text(note_path, text) VALUES(?1, ?2)")?
        .execute(params![note.path, note.text])?;
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO links(source_path, kind, target_raw, target_key, alias, pos_from, pos_to)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for link in &note.links {
            stmt.execute(params![
                note.path,
                link.kind,
                link.target_raw,
                link.target_key,
                link.alias,
                link.pos_from,
                link.pos_to
            ])?;
        }
    }
    {
        let mut stmt =
            conn.prepare_cached("INSERT INTO tags(note_path, tag, tag_key) VALUES(?1, ?2, ?3)")?;
        for tag in &note.tags {
            stmt.execute(params![note.path, tag.tag, tag.tag_key])?;
        }
    }
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO aliases(note_path, alias, alias_key) VALUES(?1, ?2, ?3)",
        )?;
        for alias in &note.aliases {
            stmt.execute(params![note.path, alias.alias, alias.alias_key])?;
        }
    }
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO note_emails(note_path, email, email_key) VALUES(?1, ?2, ?3)",
        )?;
        for email in &note.emails {
            stmt.execute(params![note.path, email.email, email.email_key])?;
        }
    }
    {
        let mut stmt =
            conn.prepare_cached("INSERT INTO assets(note_path, asset_path) VALUES(?1, ?2)")?;
        for asset in &note.assets {
            stmt.execute(params![note.path, asset])?;
        }
    }
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO tasks(note_path, marker_offset, text, breadcrumbs, raw, checked, due_date) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for task in &note.tasks {
            let breadcrumbs = serde_json::to_string(&task.breadcrumbs).map_err(|err| {
                crate::error::AppError::io(format!("serialize task breadcrumbs: {err}"))
            })?;
            stmt.execute(params![
                note.path,
                task.marker_offset,
                task.text,
                breadcrumbs,
                task.raw,
                i64::from(task.checked),
                task.due_date
            ])?;
        }
    }
    // The FTS body carries the note text plus any referenced assets' description
    // text (Plan 20), so a query matching a description surfaces the note. Only
    // the search index is enriched — `note_text`, `preview`, and AI-reachable
    // text above stay the note body alone.
    let search_body = if note.asset_text.is_empty() {
        note.text.clone()
    } else {
        format!("{}\n{}", note.text, note.asset_text)
    };
    conn.prepare_cached("INSERT INTO search_fts(path, title, body) VALUES(?1, ?2, ?3)")?
        .execute(params![note.path, note.title, search_body])?;
    Ok(())
}

/// Move every row keyed by `from` to `to` — the projection half of a file
/// rename (Plan 17). The row *moves* rather than being re-created so nothing
/// derived is lost: pinned state, conflict flags, and (critically) embedding
/// chunks, whose vectors must survive a rename — re-embedding costs the user
/// real BYOK money for identical content.
///
/// Caller wraps this in a transaction with `defer_foreign_keys` ON: the child
/// tables reference `notes(path)` and SQLite would otherwise reject updating
/// the parent key while children point at it.
///
/// An occupied destination refuses (loudly), like the filesystem half
/// (`move_note_file`): the collision probe raced something — the caller's
/// transaction rolls back, the rename reports failed, and the filename
/// drifts until the next settled rename retries. One rule, no adoption
/// heuristics. A missing `from` row is fine: an unindexed file can still be
/// renamed, and the watcher indexes it at the new path.
pub(super) fn move_note(conn: &Connection, from: &str, to: &str) -> AppResult<()> {
    let occupied: bool = conn
        .prepare_cached("SELECT 1 FROM notes WHERE path = ?1")?
        .exists(params![to])?;
    if occupied {
        return Err(crate::error::AppError::io(format!(
            "cannot move note: {to} is already indexed"
        )));
    }
    conn.prepare_cached("UPDATE notes SET path = ?2 WHERE path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE note_text SET note_path = ?2 WHERE note_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE links SET source_path = ?2 WHERE source_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE tags SET note_path = ?2 WHERE note_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE aliases SET note_path = ?2 WHERE note_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE note_emails SET note_path = ?2 WHERE note_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE assets SET note_path = ?2 WHERE note_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE tasks SET note_path = ?2 WHERE note_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE embedding_chunks SET note_path = ?2 WHERE note_path = ?1")?
        .execute(params![from, to])?;
    conn.prepare_cached("UPDATE search_fts SET path = ?2 WHERE path = ?1")?
        .execute(params![from, to])?;
    Ok(())
}

/// Wipe every derived table (for a full rebuild driven by TS). Deleting `notes`
/// cascades to every child table; `search_fts` (a virtual table, no FK) is
/// cleared explicitly. `index_meta` is intentionally preserved across a rebuild.
pub(super) fn clear_index(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "DELETE FROM notes; DELETE FROM search_fts;
         DELETE FROM embedding_vectors; DELETE FROM embedding_chunks;",
    )?;
    Ok(())
}

/// Re-stamp a note row's stored `mtime` (and `updated_at`, which `apply_note`
/// keeps equal to it) without touching the projection. The reconcile calls
/// this when a file's content hash still matches but its listed mtime doesn't
/// — otherwise the stale stamp costs a re-read on every future pass. A path
/// with no row matches nothing: a touch must never resurrect a removed note.
pub(super) fn touch_note(conn: &Connection, path: &str, mtime: i64) -> AppResult<()> {
    conn.prepare_cached("UPDATE notes SET mtime = ?2, updated_at = ?2 WHERE path = ?1")?
        .execute(params![path, mtime])?;
    Ok(())
}

/// Drop every row belonging to `path` (the `notes` row cascades to child
/// tables; `search_fts` is standalone).
pub(super) fn remove_note(conn: &Connection, path: &str) -> AppResult<()> {
    conn.prepare_cached("DELETE FROM notes WHERE path = ?1")?
        .execute(params![path])?;
    conn.prepare_cached("DELETE FROM search_fts WHERE path = ?1")?
        .execute(params![path])?;
    Ok(())
}
