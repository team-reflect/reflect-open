//! Row lookups over the `notes` and `aliases` tables.

use std::collections::HashMap;

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Func, Order, Query};

use reflect_types::{
    AppResult, NoteFileFacts, NoteId, NotePrivacy, NoteRow, PinnedNoteRow, TemplateEntry,
};

use crate::schema::{Aliases, NoteEmails, Notes, Tags};
use crate::sql::{self, lit};

/// The row of the note at `path`.
pub(crate) fn note(conn: &Connection, path: &str) -> AppResult<Option<NoteRow>> {
    sql::query_optional(
        conn,
        Query::select()
            .columns([
                Notes::Path,
                Notes::Title,
                Notes::DailyDate,
                Notes::IsPrivate,
                Notes::GistUrl,
                Notes::GistStale,
            ])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Path).eq(path)),
        |row| {
            Ok(NoteRow {
                path: row.get(0)?,
                title: row.get(1)?,
                daily_date: row.get(2)?,
                is_private: row.get(3)?,
                gist_url: row.get(4)?,
                gist_stale: row.get(5)?,
            })
        },
    )
}

/// Every pinned note, in shelf order: an explicit order first (ascending),
/// then by folded title, with the path as the tiebreak.
pub(crate) fn pinned_notes(conn: &Connection) -> AppResult<Vec<PinnedNoteRow>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                Notes::Path,
                Notes::Title,
                Notes::DailyDate,
                Notes::PinnedOrder,
            ])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::IsPinned).eq(lit(1)))
            .and_where(Expr::col(Notes::Kind).ne(lit("template")))
            .order_by_expr(Expr::col(Notes::PinnedOrder).is_null(), Order::Asc)
            .order_by_columns([
                (Notes::PinnedOrder, Order::Asc),
                (Notes::TitleKey, Order::Asc),
                (Notes::Path, Order::Asc),
            ]),
        |row| {
            Ok(PinnedNoteRow {
                path: row.get(0)?,
                title: row.get(1)?,
                daily_date: row.get(2)?,
                pinned_order: row.get(3)?,
            })
        },
    )
}

/// Every template, by folded title, with the path as the tiebreak.
pub(crate) fn templates(conn: &Connection) -> AppResult<Vec<TemplateEntry>> {
    sql::query(
        conn,
        Query::select()
            .columns([Notes::Path, Notes::Title, Notes::Mtime])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Kind).eq(lit("template")))
            .order_by_columns([(Notes::TitleKey, Order::Asc), (Notes::Path, Order::Asc)]),
        |row| {
            Ok(TemplateEntry {
                path: row.get(0)?,
                title: row.get(1)?,
                mtime: row.get(2)?,
            })
        },
    )
}

/// The stored hash and mtime of each indexed path in `paths`.
pub(crate) fn file_facts(conn: &Connection, paths: &[String]) -> AppResult<Vec<NoteFileFacts>> {
    sql::query(
        conn,
        Query::select()
            .columns([Notes::Path, Notes::FileHash, Notes::Mtime])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Path).in_subquery(sql::json_values(paths)?)),
        |row| {
            Ok(NoteFileFacts {
                path: row.get(0)?,
                file_hash: row.get(1)?,
                mtime: row.get(2)?,
            })
        },
    )
}

/// The frontmatter `id` of each indexed path in `paths`.
pub(crate) fn note_ids(conn: &Connection, paths: &[String]) -> AppResult<Vec<NoteId>> {
    sql::query(
        conn,
        Query::select()
            .columns([Notes::Path, Notes::Id])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Path).in_subquery(sql::json_values(paths)?)),
        |row| {
            Ok(NoteId {
                path: row.get(0)?,
                id: row.get(1)?,
            })
        },
    )
}

/// The path of a uniformly random note.
pub(crate) fn random_note(conn: &Connection) -> AppResult<Option<String>> {
    sql::query_optional(
        conn,
        Query::select()
            .column(Notes::Path)
            .from(Notes::Table)
            .order_by_expr(Func::random().into(), Order::Asc)
            .limit(1),
        |row| row.get(0),
    )
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
    // The first note, by path, whose `column` is `value`.
    let first_note = |column: Notes, value: &str| -> AppResult<Option<String>> {
        sql::query_optional(
            conn,
            Query::select()
                .column(Notes::Path)
                .from(Notes::Table)
                .and_where(Expr::col(column).eq(value))
                .order_by(Notes::Path, Order::Asc)
                .limit(1),
            |row| row.get(0),
        )
    };
    if let Some(path) = first_note(Notes::Id, target)? {
        return Ok(Some(path));
    }
    if daily_path.is_some() {
        return Ok(daily_path);
    }
    if let Some(path) = first_note(Notes::Path, target)? {
        return Ok(Some(path));
    }
    if let Some(path) = first_note(Notes::TitleKey, key)? {
        return Ok(Some(path));
    }
    sql::query_optional(
        conn,
        Query::select()
            .column(Aliases::NotePath)
            .from(Aliases::Table)
            .and_where(Expr::col(Aliases::AliasKey).eq(key))
            .order_by(Aliases::NotePath, Order::Asc)
            .limit(1),
        |row| row.get(0),
    )
}

/// Whether a note is indexed at `path`.
pub(crate) fn path_taken(conn: &Connection, path: &str) -> AppResult<bool> {
    let note = Query::select()
        .expr(lit(1))
        .from(Notes::Table)
        .and_where(Expr::col(Notes::Path).eq(path))
        .take();
    sql::query_one(conn, Query::select().expr(Expr::exists(note)), |row| {
        row.get(0)
    })
}

/// The notes with the tag `tag_key` that carry any of `email_keys`, by path.
pub(crate) fn person_owners(
    conn: &Connection,
    email_keys: &[String],
    tag_key: &str,
) -> AppResult<Vec<String>> {
    sql::query(
        conn,
        Query::select()
            .distinct()
            .column((Notes::Table, Notes::Path))
            .from(NoteEmails::Table)
            .inner_join(
                Notes::Table,
                Expr::col((Notes::Table, Notes::Path))
                    .equals((NoteEmails::Table, NoteEmails::NotePath)),
            )
            .inner_join(
                Tags::Table,
                Expr::col((Tags::Table, Tags::NotePath)).equals((Notes::Table, Notes::Path)),
            )
            .and_where(
                Expr::col((NoteEmails::Table, NoteEmails::EmailKey))
                    .in_subquery(sql::json_values(email_keys)?),
            )
            .and_where(Expr::col((Tags::Table, Tags::TagKey)).eq(tag_key))
            .and_where(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")))
            .order_by((Notes::Table, Notes::Path), Order::Asc),
        |row| row.get(0),
    )
}

/// The path of every note that gets embeddings, ascending: all but templates.
pub(crate) fn embeddable_paths(conn: &Connection) -> AppResult<Vec<String>> {
    sql::query(
        conn,
        Query::select()
            .column(Notes::Path)
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Kind).ne(lit("template")))
            .order_by(Notes::Path, Order::Asc),
        |row| row.get(0),
    )
}

/// The `private` flag of each indexed path in `paths`.
pub(crate) fn privacy(conn: &Connection, paths: &[String]) -> AppResult<Vec<NotePrivacy>> {
    sql::query(
        conn,
        Query::select()
            .columns([Notes::Path, Notes::IsPrivate])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Path).in_subquery(sql::json_values(paths)?)),
        |row| {
            Ok(NotePrivacy {
                path: row.get(0)?,
                is_private: row.get(1)?,
            })
        },
    )
}

/// The stored mtime and content hash of every indexed note, by path.
pub fn stored_file_facts(conn: &Connection) -> AppResult<HashMap<String, (i64, String)>> {
    sql::query(
        conn,
        Query::select()
            .columns([Notes::Path, Notes::Mtime, Notes::FileHash])
            .from(Notes::Table),
        |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))),
    )
}
