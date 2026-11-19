//! The index write path: note projections in, rows out.
//!
//! The TS↔Rust payload contract lives here ([`IndexedNote`]); all mutations are
//! plain functions over a [`Connection`] so the command layer ([`super`]) owns
//! transactions and generation gating while these stay directly unit-testable.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Query};

use reflect_types::{AppError, AppResult, IndexedNote, MovedNoteAddress};

use crate::schema::{
    Aliases, Assets, EmbeddingChunks, EmbeddingVectors, Links, NoteClaims, NoteEmails, Notes,
    SearchFts, Tags, Tasks,
};
use crate::sql::{self, lit};

/// Precedence of the spellings a note answers to (`note_claims.tier`): the
/// lowest tier claiming a key wins it. Mirrors `CLAIM_TIER` in
/// `packages/core/src/indexing/indexed-note.ts`; the numbers are the storage
/// encoding migration 0019 and the CLI read.
pub(super) mod claim_tier {
    /// Calendar-valid daily date.
    pub const DAILY_DATE: i64 = 1;
    /// Authored title. Production writes receive it from TypeScript inside
    /// `IndexedClaim`; only the test fixtures restate it natively.
    #[cfg(test)]
    pub const TITLE: i64 = 2;
    /// Frontmatter or derived alias (same test-only story as `TITLE`).
    #[cfg(test)]
    pub const ALIAS: i64 = 3;
    /// Filename stem — the weakest address.
    pub const BASENAME: i64 = 4;
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
    let path = note.path.as_str();

    sql::execute(
        conn,
        Query::insert()
            .into_table(Notes::Table)
            .columns([
                Notes::Path,
                Notes::Id,
                Notes::Title,
                Notes::TitleKey,
                Notes::PathKey,
                Notes::Kind,
                Notes::DailyDate,
                Notes::IsPrivate,
                Notes::IsPinned,
                Notes::PinnedOrder,
                Notes::GistUrl,
                Notes::GistStale,
                Notes::FileHash,
                Notes::Mtime,
                Notes::UpdatedAt,
                Notes::Preview,
                Notes::HasContent,
            ])
            .values_panic([
                path.into(),
                note.id.as_deref().into(),
                note.title.as_str().into(),
                note.title_key.as_str().into(),
                note.path_key.as_str().into(),
                note.kind.as_str().into(),
                note.daily_date.as_deref().into(),
                note.is_private.into(),
                note.is_pinned.into(),
                note.pinned_order.into(),
                note.gist_url.as_deref().into(),
                note.gist_stale.into(),
                note.file_hash.as_str().into(),
                note.mtime.into(),
                note.mtime.into(),
                note.preview.as_str().into(),
                note.has_content.into(),
            ]),
    )?;
    sql::insert_rows(
        conn,
        Links::Table,
        [
            Links::SourcePath,
            Links::Kind,
            Links::TargetRaw,
            Links::TargetKey,
            Links::TargetPathKey,
            Links::Alias,
            Links::PosFrom,
            Links::PosTo,
        ],
        note.links.iter().map(|link| {
            Ok([
                path.into(),
                link.kind.as_str().into(),
                link.target_raw.as_str().into(),
                link.target_key.as_str().into(),
                link.target_path_key.as_deref().into(),
                link.alias.as_deref().into(),
                link.pos_from.into(),
                link.pos_to.into(),
            ])
        }),
    )?;
    sql::insert_rows(
        conn,
        Tags::Table,
        [Tags::NotePath, Tags::Tag, Tags::TagKey],
        note.tags.iter().map(|tag| {
            Ok([
                path.into(),
                tag.tag.as_str().into(),
                tag.tag_key.as_str().into(),
            ])
        }),
    )?;
    sql::insert_rows(
        conn,
        Aliases::Table,
        [Aliases::NotePath, Aliases::Alias, Aliases::AliasKey],
        note.aliases.iter().map(|alias| {
            Ok([
                path.into(),
                alias.alias.as_str().into(),
                alias.alias_key.as_str().into(),
            ])
        }),
    )?;
    sql::insert_rows(
        conn,
        NoteClaims::Table,
        [NoteClaims::NotePath, NoteClaims::Key, NoteClaims::Tier],
        note.claims
            .iter()
            .map(|claim| Ok([path.into(), claim.key.as_str().into(), claim.tier.into()])),
    )?;
    sql::insert_rows(
        conn,
        NoteEmails::Table,
        [
            NoteEmails::NotePath,
            NoteEmails::Email,
            NoteEmails::EmailKey,
        ],
        note.emails.iter().map(|email| {
            Ok([
                path.into(),
                email.email.as_str().into(),
                email.email_key.as_str().into(),
            ])
        }),
    )?;
    sql::insert_rows(
        conn,
        Assets::Table,
        [Assets::NotePath, Assets::AssetPath],
        note.assets
            .iter()
            .map(|asset| Ok([path.into(), asset.as_str().into()])),
    )?;
    sql::insert_rows(
        conn,
        Tasks::Table,
        [
            Tasks::NotePath,
            Tasks::AstPath,
            Tasks::Markdown,
            Tasks::Breadcrumbs,
            Tasks::Checked,
            Tasks::DueDate,
        ],
        note.tasks.iter().map(|task| {
            let breadcrumbs = serde_json::to_string(&task.breadcrumbs)
                .map_err(|err| AppError::io(format!("serialize task breadcrumbs: {err}")))?;
            Ok([
                path.into(),
                task.ast_path.as_str().into(),
                task.markdown.as_str().into(),
                breadcrumbs.into(),
                task.checked.into(),
                task.due_date.as_deref().into(),
            ])
        }),
    )?;
    // The FTS body carries the note text plus any referenced assets' description
    // text (Plan 20), so a query matching a description surfaces the note. Only
    // the search index is enriched — `preview` and the AI-reachable text above
    // stay the note body alone.
    let search_body = if note.asset_text.is_empty() {
        note.text.clone()
    } else {
        format!("{}\n{}", note.text, note.asset_text)
    };
    sql::execute(
        conn,
        Query::insert()
            .into_table(SearchFts::Table)
            .columns([SearchFts::Path, SearchFts::Title, SearchFts::Body])
            .values_panic([path.into(), note.title.as_str().into(), search_body.into()]),
    )?;
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
pub(super) fn move_note(
    conn: &Connection,
    from: &str,
    to: &str,
    address: &MovedNoteAddress,
) -> AppResult<()> {
    let occupied = sql::exists(
        conn,
        Query::select()
            .expr(lit(1))
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Path).eq(to)),
    )?;
    if occupied {
        return Err(AppError::io(format!(
            "cannot move note: {to} is already indexed"
        )));
    }
    let moved = sql::execute(
        conn,
        Query::update()
            .table(Notes::Table)
            .value(Notes::Path, to)
            .value(Notes::PathKey, address.path_key.as_str())
            .and_where(Expr::col(Notes::Path).eq(from)),
    )?;
    move_rows(conn, NoteClaims::Table, NoteClaims::NotePath, from, to)?;
    if moved > 0 {
        // Title and alias claims live in the content and ride along; the
        // path-derived tiers are re-stated for the destination. The NOT EXISTS
        // guard mirrors `projectNoteClaims`'s seen-set: a key a carried claim
        // already holds is not claimed again. (A move that changes which tier
        // should own a key converges on the next reprojection.)
        sql::execute(
            conn,
            Query::delete()
                .from_table(NoteClaims::Table)
                .and_where(Expr::col(NoteClaims::NotePath).eq(to))
                .and_where(
                    Expr::col(NoteClaims::Tier)
                        .is_in([claim_tier::DAILY_DATE, claim_tier::BASENAME]),
                ),
        )?;
        if let Some(daily_date) = &address.daily_date {
            claim_unless_held(conn, to, daily_date, claim_tier::DAILY_DATE)?;
        }
        claim_unless_held(conn, to, &address.basename_key, claim_tier::BASENAME)?;
    }
    move_rows(conn, Links::Table, Links::SourcePath, from, to)?;
    move_rows(conn, Tags::Table, Tags::NotePath, from, to)?;
    move_rows(conn, Aliases::Table, Aliases::NotePath, from, to)?;
    move_rows(conn, NoteEmails::Table, NoteEmails::NotePath, from, to)?;
    move_rows(conn, Assets::Table, Assets::NotePath, from, to)?;
    move_rows(conn, Tasks::Table, Tasks::NotePath, from, to)?;
    move_rows(
        conn,
        EmbeddingChunks::Table,
        EmbeddingChunks::NotePath,
        from,
        to,
    )?;
    move_rows(conn, SearchFts::Table, SearchFts::Path, from, to)?;
    Ok(())
}

/// Sets `path_column` of `table` to `to` in the rows where it is `from`.
fn move_rows<T: sea_query::Iden + Copy + 'static>(
    conn: &Connection,
    table: T,
    path_column: T,
    from: &str,
    to: &str,
) -> AppResult<()> {
    sql::execute(
        conn,
        Query::update()
            .table(table)
            .value(path_column, to)
            .and_where(Expr::col(path_column).eq(from)),
    )?;
    Ok(())
}

/// Claims `key` in `tier` for the note at `path`, unless the note holds a
/// claim to the key.
fn claim_unless_held(conn: &Connection, path: &str, key: &str, tier: i64) -> AppResult<()> {
    let held = Query::select()
        .expr(lit(1))
        .from(NoteClaims::Table)
        .and_where(Expr::col(NoteClaims::NotePath).eq(path))
        .and_where(Expr::col(NoteClaims::Key).eq(key))
        .take();
    let claim = Query::select()
        .exprs([Expr::val(path), Expr::val(key), Expr::val(tier)])
        .and_where(Expr::exists(held).not())
        .take();
    let mut insert = Query::insert();
    insert
        .into_table(NoteClaims::Table)
        .columns([NoteClaims::NotePath, NoteClaims::Key, NoteClaims::Tier])
        .select_from(claim)
        .map_err(|err| AppError::io(err.to_string()))?;
    sql::execute(conn, &insert)?;
    Ok(())
}

/// Wipe every derived table (for a full rebuild driven by TS). Deleting `notes`
/// cascades to every child table; `search_fts` (a virtual table, no FK) is
/// cleared explicitly. `index_meta` is intentionally preserved across a rebuild.
pub(super) fn clear_index(conn: &Connection) -> AppResult<()> {
    sql::execute(conn, Query::delete().from_table(Notes::Table))?;
    sql::execute(conn, Query::delete().from_table(SearchFts::Table))?;
    sql::execute(conn, Query::delete().from_table(EmbeddingVectors::Table))?;
    sql::execute(conn, Query::delete().from_table(EmbeddingChunks::Table))?;
    Ok(())
}

/// Re-stamp a note row's stored `mtime` (and `updated_at`, which `apply_note`
/// keeps equal to it) without touching the projection. The reconcile calls
/// this when a file's content hash still matches but its listed mtime doesn't
/// — otherwise the stale stamp costs a re-read on every future pass. A path
/// with no row matches nothing: a touch must never resurrect a removed note.
pub(super) fn touch_note(conn: &Connection, path: &str, mtime: i64) -> AppResult<()> {
    sql::execute(
        conn,
        Query::update()
            .table(Notes::Table)
            .value(Notes::Mtime, mtime)
            .value(Notes::UpdatedAt, mtime)
            .and_where(Expr::col(Notes::Path).eq(path)),
    )?;
    Ok(())
}

/// Drop every row belonging to `path` (the `notes` row cascades to child
/// tables; `search_fts` is standalone).
pub(super) fn remove_note(conn: &Connection, path: &str) -> AppResult<()> {
    sql::execute(
        conn,
        Query::delete()
            .from_table(Notes::Table)
            .and_where(Expr::col(Notes::Path).eq(path)),
    )?;
    sql::execute(
        conn,
        Query::delete()
            .from_table(SearchFts::Table)
            .and_where(Expr::col(SearchFts::Path).eq(path)),
    )?;
    Ok(())
}
