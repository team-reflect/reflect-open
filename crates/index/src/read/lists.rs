//! The note lists: the All Notes list, recent notes and tag facets.

use std::collections::HashMap;

use rusqlite::{Connection, Row};
use sea_query::{Asterisk, Expr, ExprTrait, Func, Order, Query, SelectStatement};

use reflect_types::{AppResult, NoteListEntry, RecentNoteRow, TagFacet};

use crate::schema::{Notes, Tags};
use crate::sql::{self, lit};

/// The recall-feed order: pins first (an explicit order before unordered
/// pins), then recency, with the path as the stable tiebreak.
pub(crate) const PINNED_FIRST_ORDER: &str = "notes.is_pinned DESC, notes.pinned_order IS NULL, notes.pinned_order, notes.mtime DESC, notes.path";

/// The recall-feed order without pins: recency, then the path.
pub(crate) const RECENT_ORDER: &str = "notes.mtime DESC, notes.path";

/// The alias of `tags` in a tag filter.
pub(crate) const FILTER_TAGS: &str = "filter_tags";

/// The recall-feed order: pins first (an explicit order before unordered
/// pins), then recency, with the path as the stable tiebreak.
pub(crate) fn order_pinned_first(query: &mut SelectStatement) {
    query
        .order_by((Notes::Table, Notes::IsPinned), Order::Desc)
        .order_by_expr(
            Expr::col((Notes::Table, Notes::PinnedOrder)).is_null(),
            Order::Asc,
        )
        .order_by((Notes::Table, Notes::PinnedOrder), Order::Asc);
    order_recent(query);
}

/// The recall-feed order without pins: recency, then the path.
pub(crate) fn order_recent(query: &mut SelectStatement) {
    query
        .order_by((Notes::Table, Notes::Mtime), Order::Desc)
        .order_by((Notes::Table, Notes::Path), Order::Asc);
}

/// `notes JOIN tags` on the note path, from `tags`.
pub(crate) fn from_tags_join_notes(query: &mut SelectStatement) {
    query.from(Tags::Table).inner_join(
        Notes::Table,
        Expr::col((Notes::Table, Notes::Path)).equals((Tags::Table, Tags::NotePath)),
    );
}

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
    let listed_kinds = [lit("note"), lit("daily")];

    let mut query = Query::select();
    query.columns([
        (Notes::Table, Notes::Path),
        (Notes::Table, Notes::Title),
        (Notes::Table, Notes::Mtime),
        (Notes::Table, Notes::Preview),
        (Notes::Table, Notes::IsPinned),
    ]);
    match tag_key {
        None => {
            query
                .from(Notes::Table)
                .and_where(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")));
        }
        Some(tag_key) => {
            query.distinct().column((Notes::Table, Notes::PinnedOrder));
            from_tags_join_notes(&mut query);
            query
                .and_where(Expr::col((Tags::Table, Tags::TagKey)).eq(tag_key))
                .and_where(Expr::col((Notes::Table, Notes::Kind)).is_in(listed_kinds.clone()));
        }
    }
    order_pinned_first(&mut query);
    let mut entries: Vec<NoteListEntry> = sql::query(conn, &query, list_entry)?;
    if entries.is_empty() {
        return Ok(entries);
    }

    // The tags of the same note set, through the same predicates. The folded
    // key orders them like the facet list, whatever the display casing.
    let mut query = Query::select();
    query.columns([(Tags::Table, Tags::NotePath), (Tags::Table, Tags::Tag)]);
    from_tags_join_notes(&mut query);
    match tag_key {
        None => {
            query.and_where(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")));
        }
        Some(tag_key) => {
            query
                .distinct()
                .join_as(
                    sea_query::JoinType::InnerJoin,
                    Tags::Table,
                    FILTER_TAGS,
                    Expr::col((FILTER_TAGS, Tags::NotePath)).equals((Notes::Table, Notes::Path)),
                )
                .and_where(Expr::col((FILTER_TAGS, Tags::TagKey)).eq(tag_key))
                .and_where(Expr::col((Notes::Table, Notes::Kind)).is_in(listed_kinds));
        }
    }
    query.order_by((Tags::Table, Tags::TagKey), Order::Asc);
    let tags: Vec<(String, String)> =
        sql::query(conn, &query, |row| Ok((row.get(0)?, row.get(1)?)))?;

    let mut tags_by_path: HashMap<String, Vec<String>> = HashMap::new();
    for (path, tag) in tags {
        tags_by_path.entry(path).or_default().push(tag);
    }
    for entry in &mut entries {
        entry.tags = tags_by_path.remove(&entry.path).unwrap_or_default();
    }
    Ok(entries)
}

/// The most recently changed non-private notes, at most `limit`, with the tag
/// `tag_key` when one is given.
pub(crate) fn recent_notes(
    conn: &Connection,
    limit: u32,
    tag_key: Option<&str>,
) -> AppResult<Vec<RecentNoteRow>> {
    let mut query = Query::select();
    query.columns([
        (Notes::Table, Notes::Path),
        (Notes::Table, Notes::Title),
        (Notes::Table, Notes::Preview),
        (Notes::Table, Notes::Mtime),
        (Notes::Table, Notes::IsPrivate),
    ]);
    match tag_key {
        None => {
            query.from(Notes::Table);
        }
        Some(tag_key) => {
            query.distinct();
            from_tags_join_notes(&mut query);
            query.and_where(Expr::col((Tags::Table, Tags::TagKey)).eq(tag_key));
        }
    }
    query
        .and_where(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")))
        .and_where(Expr::col((Notes::Table, Notes::IsPrivate)).eq(lit(0)));
    order_recent(&mut query);
    query.limit(u64::from(limit));
    sql::query(conn, &query, |row| {
        Ok(RecentNoteRow {
            path: row.get(0)?,
            title: row.get(1)?,
            preview: row.get(2)?,
            mtime: row.get(3)?,
            is_private: row.get(4)?,
        })
    })
}

/// The display casing and the note count of each tag key: `min(tag)`,
/// `count(*)` over `tags JOIN notes`, grouped by the key.
pub(crate) fn tag_facets() -> SelectStatement {
    let mut query = Query::select();
    query
        .expr(Func::min(Expr::col((Tags::Table, Tags::Tag))))
        .expr(Func::count(Expr::col(Asterisk)));
    from_tags_join_notes(&mut query);
    query.group_by_col((Tags::Table, Tags::TagKey));
    query
}

pub(crate) fn tag_facet(row: &Row<'_>) -> rusqlite::Result<TagFacet> {
    Ok(TagFacet {
        tag: row.get(0)?,
        count: row.get(1)?,
    })
}

/// The tag facets over non-daily notes, by tag key, each with one display
/// casing.
pub(crate) fn note_tags(conn: &Connection) -> AppResult<Vec<TagFacet>> {
    sql::query(
        conn,
        tag_facets()
            .and_where(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")))
            .order_by((Tags::Table, Tags::TagKey), Order::Asc),
        tag_facet,
    )
}
