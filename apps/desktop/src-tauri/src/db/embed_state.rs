//! Successful embedding projections and cheap discovery of dirty notes.
//!
//! Note hashes come from the index; sidecar revisions are probed locally because
//! user-authored description files can change without a note watcher event.
//! No note or description content is read during discovery.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::AppResult;
use crate::fs::{eviction_placeholder, is_dataless, resolve_in_graph};

/// One dirty note and the input snapshot observed during discovery.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingEmbedding {
    pub(super) path: String,
    pub(super) fingerprint: String,
}

/// Input snapshot required before reading/chunking a dirty note.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingPreparation {
    pub(super) fingerprint: String,
    pub(super) file_hash: String,
    pub(super) asset_paths: Vec<String>,
}

pub(super) struct Source {
    path: String,
    file_hash: String,
    saved: Option<String>,
    assets: Vec<String>,
}

pub(super) fn sources(conn: &Connection, path: Option<&str>) -> AppResult<Vec<Source>> {
    // One query for discovery, including asset references. The path-specific
    // form retains indexed lookups instead of an optional-parameter OR scan.
    let predicate = if path.is_some() {
        " AND notes.path = ?1"
    } else {
        ""
    };
    let sql = format!(
        "SELECT notes.path, notes.file_hash, state.fingerprint, assets.asset_path
         FROM notes
         LEFT JOIN embedding_state AS state ON state.note_path = notes.path
         LEFT JOIN assets ON assets.note_path = notes.path
         WHERE notes.kind != 'template'{predicate}
         ORDER BY notes.path, assets.asset_path"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = if let Some(path) = path {
        stmt.query([path])?
    } else {
        stmt.query([])?
    };
    let mut sources: Vec<Source> = Vec::new();
    while let Some(row) = rows.next()? {
        let path: String = row.get(0)?;
        if sources.last().is_none_or(|source| source.path != path) {
            sources.push(Source {
                path,
                file_hash: row.get(1)?,
                saved: row.get(2)?,
                assets: Vec::new(),
            });
        }
        if let Some(asset) = row.get::<_, Option<String>>(3)? {
            sources
                .last_mut()
                .expect("source was inserted")
                .assets
                .push(asset);
        }
    }
    Ok(sources)
}

fn hash_field(hash: &mut Sha256, value: &str) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value.as_bytes());
}

/// Metadata changes are conservative invalidations: touching an unchanged
/// sidecar can repeat chunking, but never makes inference mandatory. Include
/// identity and change time so equal-size rewrites/restored mtimes do
/// not masquerade as the same revision. Missing and evicted are distinct.
fn asset_revision(root: &Path, asset: &str) -> AppResult<Option<String>> {
    let absolute = resolve_in_graph(root, &format!("{asset}.reflect.md"))?;
    match std::fs::metadata(&absolute) {
        Ok(metadata) if is_dataless(&metadata) => Ok(None),
        Ok(metadata) => Ok(Some(super::embed_revision::metadata_revision(
            &absolute, &metadata,
        )?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if eviction_placeholder(&absolute).is_some_and(|stub| stub.exists()) {
                Ok(None)
            } else {
                Ok(Some("missing".to_string()))
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn fingerprint(
    source: &Source,
    root: &Path,
    model_id: &str,
    projection_version: u32,
    revisions: &mut HashMap<String, Option<String>>,
) -> AppResult<Option<String>> {
    let mut hash = Sha256::new();
    hash_field(&mut hash, "embedding-input-v1");
    hash_field(&mut hash, &source.path);
    hash_field(&mut hash, &source.file_hash);
    hash_field(&mut hash, model_id);
    hash.update(projection_version.to_le_bytes());
    for asset in &source.assets {
        if !revisions.contains_key(asset) {
            revisions.insert(asset.clone(), asset_revision(root, asset)?);
        }
        let Some(revision) = &revisions[asset] else {
            return Ok(None);
        };
        hash_field(&mut hash, asset);
        hash_field(&mut hash, revision);
    }
    Ok(Some(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    ))
}

/// Return dirty/missing projections without reading note bodies, chunk rows,
/// or vectors. Shared descriptions are statted once per discovery pass.
pub(super) fn pending(
    sources: Vec<Source>,
    root: &Path,
    model_id: &str,
    projection_version: u32,
) -> AppResult<Vec<PendingEmbedding>> {
    let mut revisions = HashMap::new();
    let mut pending = Vec::new();
    for source in sources {
        let fingerprint = match fingerprint(
            &source,
            root,
            model_id,
            projection_version,
            &mut revisions,
        ) {
            Ok(Some(fingerprint)) => fingerprint,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(path = %source.path, ?error, "embedding input unavailable; retry on next pass");
                continue;
            }
        };
        if source.saved.as_ref() != Some(&fingerprint) {
            pending.push(PendingEmbedding {
                path: source.path,
                fingerprint,
            });
        }
    }
    Ok(pending)
}

/// Recheck a path immediately before work. Clean, removed, template and
/// evicted-description notes require no reads or writes this pass.
pub(super) fn prepare(
    conn: &Connection,
    root: &Path,
    path: &str,
    model_id: &str,
    projection_version: u32,
) -> AppResult<Option<EmbeddingPreparation>> {
    let Some(source) = sources(conn, Some(path))?.pop() else {
        return Ok(None);
    };
    let Some(fingerprint) = fingerprint(
        &source,
        root,
        model_id,
        projection_version,
        &mut HashMap::new(),
    )?
    else {
        return Ok(None);
    };
    if source.saved.as_ref() == Some(&fingerprint) {
        return Ok(None);
    }
    Ok(Some(EmbeddingPreparation {
        fingerprint,
        file_hash: source.file_hash,
        asset_paths: source.assets,
    }))
}

/// Commit the checkpoint only after the full chunk diff succeeded, in the
/// caller's transaction. Empty chunk sets are successful projections too.
pub(super) fn save(conn: &Connection, path: &str, fingerprint: &str) -> AppResult<()> {
    conn.prepare_cached(
        "INSERT INTO embedding_state(note_path, fingerprint) VALUES(?1, ?2)
         ON CONFLICT(note_path) DO UPDATE SET fingerprint = excluded.fingerprint",
    )?
    .execute(params![path, fingerprint])?;
    Ok(())
}

/// Compare the complete input snapshot again before mutating either chunks or
/// the checkpoint. A raced edit/deletion/model pass is harmless and stays dirty.
pub(super) fn apply(
    conn: &Connection,
    root: &Path,
    path: &str,
    fingerprint: &str,
    model_id: &str,
    projection_version: u32,
    chunks: &[super::embed_write::EmbeddedChunk],
) -> AppResult<()> {
    let Some(current) = prepare(conn, root, path, model_id, projection_version)? else {
        return Ok(());
    };
    if current.fingerprint != fingerprint {
        return Ok(());
    }
    if chunks.iter().any(|chunk| chunk.model_id != model_id) {
        return Err(crate::error::AppError::parse(
            "embedding chunk model does not match checkpoint",
        ));
    }
    super::embed_write::apply_chunks(conn, path, chunks)?;
    save(conn, path, fingerprint)
}
