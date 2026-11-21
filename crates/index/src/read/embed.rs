//! Reads of the embedding tables.

use rusqlite::{Connection, Row};
use sea_query::extension::sqlite::SqliteBinOper;
use sea_query::{Expr, ExprTrait, Func, Order, Query, SelectStatement};

use reflect_types::{AppResult, ChunkHash, ChunkHit};

use crate::embed_write::vector_json;
use crate::schema::{EmbeddingChunks, EmbeddingVectors, Notes};
use crate::sql::{self, lit};

/// The hash and model of each stored chunk of the note at `note_path`.
pub(crate) fn chunk_hashes(conn: &Connection, note_path: &str) -> AppResult<Vec<ChunkHash>> {
    sql::query(
        conn,
        Query::select()
            .columns([EmbeddingChunks::ContentHash, EmbeddingChunks::ModelId])
            .from(EmbeddingChunks::Table)
            .and_where(Expr::col(EmbeddingChunks::NotePath).eq(note_path)),
        |row| {
            Ok(ChunkHash {
                content_hash: row.get(0)?,
                model_id: row.get(1)?,
            })
        },
    )
}

fn chunk_hit(row: &Row<'_>) -> rusqlite::Result<ChunkHit> {
    Ok(ChunkHit {
        path: row.get(0)?,
        title: row.get(1)?,
        heading: row.get(2)?,
        text: row.get(3)?,
        is_private: row.get(4)?,
        distance: row.get(5)?,
    })
}

/// The `candidates` nearest chunks to the vector with the JSON text `vector`,
/// nearest first.
fn nearest_chunks(vector: String, candidates: u32) -> SelectStatement {
    Query::select()
        .column((EmbeddingChunks::Table, EmbeddingChunks::NotePath))
        .column((Notes::Table, Notes::Title))
        .columns([
            (EmbeddingChunks::Table, EmbeddingChunks::Heading),
            (EmbeddingChunks::Table, EmbeddingChunks::Text),
        ])
        .column((Notes::Table, Notes::IsPrivate))
        .column((EmbeddingVectors::Table, EmbeddingVectors::Distance))
        .from(EmbeddingVectors::Table)
        .inner_join(
            EmbeddingChunks::Table,
            Expr::col((EmbeddingChunks::Table, EmbeddingChunks::Id))
                .equals((EmbeddingVectors::Table, EmbeddingVectors::Rowid)),
        )
        .inner_join(
            Notes::Table,
            Expr::col((Notes::Table, Notes::Path))
                .equals((EmbeddingChunks::Table, EmbeddingChunks::NotePath)),
        )
        .and_where(
            Expr::col((EmbeddingVectors::Table, EmbeddingVectors::Embedding))
                .binary(SqliteBinOper::Match, vector),
        )
        .and_where(Expr::col((EmbeddingVectors::Table, EmbeddingVectors::K)).eq(candidates))
        .order_by(
            (EmbeddingVectors::Table, EmbeddingVectors::Distance),
            Order::Asc,
        )
        .take()
}

/// The non-private chunks among the `candidates` nearest chunks to each of
/// the first `seed_limit` chunks of the note at `note_path`: one list per seed
/// chunk, nearest first. The private filter runs after the nearest-neighbour
/// limit, so a list can be shorter than `candidates`. The note's own chunks
/// are in the lists.
pub(crate) fn related_chunks(
    conn: &Connection,
    note_path: &str,
    seed_limit: u32,
    candidates: u32,
) -> AppResult<Vec<Vec<ChunkHit>>> {
    let seeds: Vec<String> = sql::query(
        conn,
        Query::select()
            .expr(Func::cust("vec_to_json").arg(Expr::col((
                EmbeddingVectors::Table,
                EmbeddingVectors::Embedding,
            ))))
            .from(EmbeddingChunks::Table)
            .inner_join(
                EmbeddingVectors::Table,
                Expr::col((EmbeddingVectors::Table, EmbeddingVectors::Rowid))
                    .equals((EmbeddingChunks::Table, EmbeddingChunks::Id)),
            )
            .and_where(Expr::col((EmbeddingChunks::Table, EmbeddingChunks::NotePath)).eq(note_path))
            .order_by(
                (EmbeddingChunks::Table, EmbeddingChunks::PosFrom),
                Order::Asc,
            )
            .limit(u64::from(seed_limit)),
        |row| row.get(0),
    )?;
    seeds
        .into_iter()
        .map(|seed| {
            sql::query(
                conn,
                nearest_chunks(seed, candidates)
                    .and_where(Expr::col((Notes::Table, Notes::IsPrivate)).eq(lit(0))),
                chunk_hit,
            )
        })
        .collect()
}

/// The nearest chunks to `vector`, nearest first, at most `candidates`.
/// Private notes are included: the caller decides what leaves the device.
pub(crate) fn semantic_chunks(
    conn: &Connection,
    vector: &[f32],
    candidates: u32,
) -> AppResult<Vec<ChunkHit>> {
    sql::query(
        conn,
        &nearest_chunks(vector_json(vector), candidates),
        chunk_hit,
    )
}
