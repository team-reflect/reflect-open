//! Wiki link resolution over `note_keys`, `note_claims` and `links`.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Func, Order, Query};

use reflect_types::{AppResult, WikiClaimMatch, WikiTitleCandidate};

use crate::schema::{Links, NoteClaims, NoteKeys, Notes};
use crate::sql::{self, lit};

/// The note that wins the wiki key `key`: `note_keys` holds one winner per
/// key.
pub(crate) fn resolve(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    sql::query_optional(
        conn,
        Query::select()
            .column(NoteKeys::NotePath)
            .from(NoteKeys::Table)
            .and_where(Expr::col(NoteKeys::Key).eq(key))
            .limit(1),
        |row| row.get(0),
    )
}

/// The notes that claim `key` in its strongest tier, by path. One statement
/// reads the tier and its notes, so a caller with no transaction still gets
/// a consistent answer.
pub fn claim_match(conn: &Connection, key: &str) -> AppResult<Option<WikiClaimMatch>> {
    let strongest_tier = Query::select()
        .expr(Func::min(Expr::col(NoteClaims::Tier)))
        .from(NoteClaims::Table)
        .and_where(Expr::col(NoteClaims::Key).eq(key))
        .take();
    let claims: Vec<(String, i64)> = sql::query(
        conn,
        Query::select()
            .distinct()
            .columns([NoteClaims::NotePath, NoteClaims::Tier])
            .from(NoteClaims::Table)
            .and_where(Expr::col(NoteClaims::Key).eq(key))
            .and_where(Expr::col(NoteClaims::Tier).eq(strongest_tier))
            .order_by(NoteClaims::NotePath, Order::Asc),
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let Some(tier) = claims.first().map(|(_, tier)| *tier) else {
        return Ok(None);
    };
    let paths = claims.into_iter().map(|(path, _)| path).collect();
    Ok(Some(WikiClaimMatch { tier, paths }))
}

/// The notes whose folded path is `path_key`, by path.
pub(crate) fn notes_by_path_key(conn: &Connection, path_key: &str) -> AppResult<Vec<String>> {
    sql::query(
        conn,
        Query::select()
            .distinct()
            .column(Notes::Path)
            .from(Notes::Table)
            .and_where(Expr::col(Notes::PathKey).eq(path_key))
            .order_by(Notes::Path, Order::Asc),
        |row| row.get(0),
    )
}

/// The notes with a link whose `column` is `key`, by path.
fn sources(conn: &Connection, column: Links, key: &str) -> AppResult<Vec<String>> {
    sql::query(
        conn,
        Query::select()
            .distinct()
            .column(Links::SourcePath)
            .from(Links::Table)
            .and_where(Expr::col(column).eq(key))
            .order_by(Links::SourcePath, Order::Asc),
        |row| row.get(0),
    )
}

/// The notes with a link to the wiki key `target_key`, by path.
pub(crate) fn link_sources(conn: &Connection, target_key: &str) -> AppResult<Vec<String>> {
    sources(conn, Links::TargetKey, target_key)
}

/// The notes with a link to the folded path `target_path_key`, by path.
pub(crate) fn path_link_sources(
    conn: &Connection,
    target_path_key: &str,
) -> AppResult<Vec<String>> {
    sources(conn, Links::TargetPathKey, target_path_key)
}

/// The note at `path` as a suggestion candidate, with no link count.
/// Templates have none.
pub(crate) fn address_note(conn: &Connection, path: &str) -> AppResult<Option<WikiTitleCandidate>> {
    sql::query_optional(
        conn,
        Query::select()
            .columns([
                Notes::Path,
                Notes::Title,
                Notes::TitleKey,
                Notes::DailyDate,
                Notes::Mtime,
            ])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Path).eq(path))
            .and_where(Expr::col(Notes::Kind).ne(lit("template"))),
        |row| {
            Ok(WikiTitleCandidate {
                path: row.get(0)?,
                title: row.get(1)?,
                title_key: row.get(2)?,
                daily_date: row.get(3)?,
                mtime: row.get(4)?,
                link_count: 0,
            })
        },
    )
}
