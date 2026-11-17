//! Embedding-table writes (Plan 09): chunk rows + their vec0 vectors, applied
//! per note as one diff. Plain functions over a [`Connection`] — the command
//! layer ([`super`]) owns transactions and generation gating, mirroring
//! `write.rs`.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Order, Query};

use reflect_types::{AppError, AppResult, EmbeddedChunk};

use crate::schema::{EmbeddingChunks, EmbeddingVectors, Notes};
use crate::sql::{self, lit};

pub(crate) fn vector_json(vector: &[f32]) -> String {
    let mut out = String::with_capacity(vector.len() * 10 + 2);
    out.push('[');
    for (i, value) in vector.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
    out
}

/// Apply `chunks` as the note's complete new chunk set: rows whose hash isn't
/// in the set are dropped (vectors included), kept rows get fresh metadata,
/// and chunks carrying a vector are inserted. A "new" chunk without a vector
/// is a pipeline bug — fail loudly rather than store an unsearchable row.
pub(super) fn apply_chunks(
    conn: &Connection,
    note_path: &str,
    chunks: &[EmbeddedChunk],
) -> AppResult<()> {
    // Chunks only exist for indexed notes. The embedding pipeline runs on its
    // own queue, so a slow in-flight embed can land after index_remove
    // deleted the note — without this guard it would reinsert vectors for a
    // dead path (which surface as stale text if the path is later reused).
    let note = Query::select()
        .expr(lit(1))
        .from(Notes::Table)
        .and_where(Expr::col(Notes::Path).eq(note_path))
        .take();
    let note_exists: bool =
        sql::query_one(conn, Query::select().expr(Expr::exists(note)), |row| {
            row.get(0)
        })?;
    if !note_exists {
        return remove_chunks(conn, note_path); // hygiene: drop any leftovers
    }

    // Existing rows by content hash (a note rarely has duplicate-hash chunks;
    // if it does, rows pair up by position order — both forms are identical).
    let mut existing: Vec<(i64, String)> = sql::query(
        conn,
        Query::select()
            .columns([EmbeddingChunks::Id, EmbeddingChunks::ContentHash])
            .from(EmbeddingChunks::Table)
            .and_where(Expr::col(EmbeddingChunks::NotePath).eq(note_path))
            .order_by(EmbeddingChunks::PosFrom, Order::Asc),
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    for chunk in chunks {
        match chunk.vector.as_ref() {
            None => {
                let at = existing
                    .iter()
                    .position(|(_, hash)| *hash == chunk.content_hash)
                    .ok_or_else(|| {
                        AppError::parse(format!(
                            "unchanged chunk has no stored row (hash {})",
                            chunk.content_hash
                        ))
                    })?;
                let (id, _) = existing.remove(at);
                sql::execute(
                    conn,
                    Query::update()
                        .table(EmbeddingChunks::Table)
                        .value(EmbeddingChunks::Heading, chunk.heading.as_deref())
                        .value(EmbeddingChunks::PosFrom, chunk.pos_from)
                        .value(EmbeddingChunks::PosTo, chunk.pos_to)
                        .value(EmbeddingChunks::ModelId, chunk.model_id.as_str())
                        .and_where(Expr::col(EmbeddingChunks::Id).eq(id)),
                )?;
            }
            Some(vector) => {
                sql::execute(
                    conn,
                    Query::insert()
                        .into_table(EmbeddingChunks::Table)
                        .columns([
                            EmbeddingChunks::NotePath,
                            EmbeddingChunks::Heading,
                            EmbeddingChunks::PosFrom,
                            EmbeddingChunks::PosTo,
                            EmbeddingChunks::Text,
                            EmbeddingChunks::ContentHash,
                            EmbeddingChunks::ModelId,
                        ])
                        .values_panic([
                            note_path.into(),
                            chunk.heading.as_deref().into(),
                            chunk.pos_from.into(),
                            chunk.pos_to.into(),
                            chunk.text.as_str().into(),
                            chunk.content_hash.as_str().into(),
                            chunk.model_id.as_str().into(),
                        ]),
                )?;
                let id = conn.last_insert_rowid();
                sql::execute(
                    conn,
                    Query::insert()
                        .into_table(EmbeddingVectors::Table)
                        .columns([EmbeddingVectors::Rowid, EmbeddingVectors::Embedding])
                        .values_panic([id.into(), vector_json(vector).into()]),
                )?;
            }
        }
    }

    // Whatever wasn't kept is stale: drop vector + row.
    for (id, _) in existing {
        sql::execute(
            conn,
            Query::delete()
                .from_table(EmbeddingVectors::Table)
                .and_where(Expr::col(EmbeddingVectors::Rowid).eq(id)),
        )?;
        sql::execute(
            conn,
            Query::delete()
                .from_table(EmbeddingChunks::Table)
                .and_where(Expr::col(EmbeddingChunks::Id).eq(id)),
        )?;
    }
    Ok(())
}

/// Drop every chunk + vector belonging to `note_path` (note deletion).
pub(super) fn remove_chunks(conn: &Connection, note_path: &str) -> AppResult<()> {
    let chunk_ids = Query::select()
        .column(EmbeddingChunks::Id)
        .from(EmbeddingChunks::Table)
        .and_where(Expr::col(EmbeddingChunks::NotePath).eq(note_path))
        .take();
    sql::execute(
        conn,
        Query::delete()
            .from_table(EmbeddingVectors::Table)
            .and_where(Expr::col(EmbeddingVectors::Rowid).in_subquery(chunk_ids)),
    )?;
    sql::execute(
        conn,
        Query::delete()
            .from_table(EmbeddingChunks::Table)
            .and_where(Expr::col(EmbeddingChunks::NotePath).eq(note_path)),
    )?;
    Ok(())
}
