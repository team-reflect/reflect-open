//! Reads of the embedding tables.

use rusqlite::{Connection, Row, params};

use reflect_types::{AppResult, ChunkHash, ChunkHit};

use crate::embed_write::vector_json;

/// The hash and model of each stored chunk of the note at `note_path`.
pub(crate) fn chunk_hashes(conn: &Connection, note_path: &str) -> AppResult<Vec<ChunkHash>> {
    let hashes = conn
        .prepare_cached("SELECT content_hash, model_id FROM embedding_chunks WHERE note_path = ?1")?
        .query_map([note_path], |row| {
            Ok(ChunkHash {
                content_hash: row.get(0)?,
                model_id: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(hashes)
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
    let seeds: Vec<String> = conn
        .prepare_cached(
            "SELECT vec_to_json(v.embedding) FROM embedding_chunks c
             JOIN embedding_vectors v ON v.rowid = c.id
             WHERE c.note_path = ?1
             ORDER BY c.pos_from
             LIMIT ?2",
        )?
        .query_map(params![note_path, seed_limit], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let mut neighbors = conn.prepare_cached(
        "SELECT c.note_path, n.title, c.heading, c.text, n.is_private, v.distance
         FROM embedding_vectors v
         JOIN embedding_chunks c ON c.id = v.rowid
         JOIN notes n ON n.path = c.note_path
         WHERE v.embedding MATCH ?1 AND k = ?2 AND n.is_private = 0
         ORDER BY v.distance",
    )?;
    seeds
        .iter()
        .map(|seed| {
            Ok(neighbors
                .query_map(params![seed, candidates], chunk_hit)?
                .collect::<Result<_, _>>()?)
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
    let hits = conn
        .prepare_cached(
            "SELECT c.note_path, n.title, c.heading, c.text, n.is_private, v.distance
             FROM embedding_vectors v
             JOIN embedding_chunks c ON c.id = v.rowid
             JOIN notes n ON n.path = c.note_path
             WHERE v.embedding MATCH ?1 AND k = ?2
             ORDER BY v.distance",
        )?
        .query_map(params![vector_json(vector), candidates], chunk_hit)?
        .collect::<Result<_, _>>()?;
    Ok(hits)
}
