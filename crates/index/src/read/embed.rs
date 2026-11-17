//! Reads of the embedding tables.

use rusqlite::Connection;

use reflect_types::{AppResult, ChunkHash};

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
