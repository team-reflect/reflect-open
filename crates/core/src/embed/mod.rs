//! The local embedding runtime (Plan 09): the `reflect-embed` model, off the
//! UI thread, with its status on `embed:status` events. Every failure degrades to a reported "unavailable" state (the same
//! recoverable contract as sqlite-vec): semantic search is strictly additive,
//! so nothing here may ever take the app down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use reflect_embed::{MODEL_ID, MODEL_SIZE, Model};
use reflect_types::{
    AppError, AppResult, ChunkHash, ChunkToEmbed, EmbedProgress, EmbedStatus, EmbeddedChunk,
};

use crate::{Core, Host, background_task};

// The index stores vectors of the model's length.
const _: () = assert!(reflect_embed::DIMS == reflect_index_schema::EMBEDDING_DIMS);

/// How many newly downloaded bytes accumulate between progress events, so the
/// IPC channel carries few events and the progress bar still moves smoothly.
const PROGRESS_EMIT_STEP: u64 = 1024 * 1024;

#[derive(Default)]
enum Runtime {
    #[default]
    Uninitialized,
    Loading {
        progress: Option<EmbedProgress>,
    },
    Ready(Arc<Mutex<Model>>),
    Failed(String),
}

/// Process-wide embedding runtime state.
#[derive(Default)]
pub struct EmbedState(Mutex<Runtime>);

fn lock_state(state: &EmbedState) -> AppResult<std::sync::MutexGuard<'_, Runtime>> {
    state.0.lock().map_err(|err| {
        tracing::error!(?err, "embed state lock poisoned by an earlier panic");
        AppError::io("embed state lock poisoned")
    })
}

fn status_of(runtime: &Runtime) -> EmbedStatus {
    match runtime {
        Runtime::Uninitialized => EmbedStatus::Uninitialized,
        Runtime::Loading { progress } => EmbedStatus::Loading {
            progress: *progress,
        },
        Runtime::Ready(_) => EmbedStatus::Ready {
            model: MODEL_ID.to_string(),
        },
        Runtime::Failed(message) => EmbedStatus::Failed {
            message: message.clone(),
        },
    }
}

fn emit_status(host: &dyn Host, status: &EmbedStatus) {
    if let Ok(payload) = serde_json::to_value(status) {
        host.emit("embed:status", payload);
    }
}

/// Record download progress on the runtime state, so an `embed_status` poll
/// (e.g. a UI surface mounted mid-download) reports the same bytes as the
/// `embed:status` events, then emit it. Only an in-flight load is updated.
fn report_progress(host: &dyn Host, state: &Mutex<Runtime>, downloaded: u64) {
    let progress = EmbedProgress {
        downloaded,
        total: MODEL_SIZE,
    };
    if let Ok(mut runtime) = state.lock()
        && matches!(*runtime, Runtime::Loading { .. })
    {
        *runtime = Runtime::Loading {
            progress: Some(progress),
        };
    }
    emit_status(
        host,
        &EmbedStatus::Loading {
            progress: Some(progress),
        },
    );
}

/// The model file in `models_dir`, downloaded first unless it is there. The
/// download progress goes to the runtime state and to `embed:status` events.
async fn ensure_model_file(
    host: &dyn Host,
    state: &Mutex<Runtime>,
    models_dir: &Path,
) -> Result<PathBuf, String> {
    let mut emitted: Option<u64> = None;
    reflect_embed::download_model(models_dir, |downloaded| {
        // `abs_diff`: the count drops to zero when the server ignores the
        // resume range and the download starts over.
        let due = emitted.is_none_or(|last| {
            downloaded.abs_diff(last) >= PROGRESS_EMIT_STEP || downloaded == MODEL_SIZE
        });
        if due {
            emitted = Some(downloaded);
            report_progress(host, state, downloaded);
        }
    })
    .await
}

impl Core {
    /// Current runtime status (poll on startup; live changes arrive on
    /// `embed:status` events).
    pub fn embed_status(&self) -> AppResult<EmbedStatus> {
        if !reflect_embed::supported() {
            return Ok(EmbedStatus::Unsupported);
        }
        Ok(status_of(&*lock_state(&self.embed)?))
    }

    /// Ensure the model is loaded, downloading it on first use. Idempotent: a
    /// concurrent call while loading returns immediately (the event stream
    /// carries the outcome). A failed download resumes on the next call.
    pub async fn embed_ensure(&self) -> AppResult<EmbedStatus> {
        if !reflect_embed::supported() {
            return Ok(EmbedStatus::Unsupported);
        }
        // Resolve the directory BEFORE flipping to Loading: it's the only step
        // here that may fail without a guaranteed state transition afterwards.
        let models_dir = self.models_dir()?;

        {
            let mut runtime = lock_state(&self.embed)?;
            match &*runtime {
                Runtime::Ready(_) | Runtime::Loading { .. } => return Ok(status_of(&runtime)),
                Runtime::Uninitialized | Runtime::Failed(_) => {
                    *runtime = Runtime::Loading { progress: None };
                }
            }
        }
        emit_status(self.host(), &EmbedStatus::Loading { progress: None });

        // From here every path must land the state in Ready or Failed: an
        // early `?` would wedge the runtime in Loading forever (later ensures
        // return early on Loading).
        let loaded = match ensure_model_file(self.host(), &self.embed.0, &models_dir).await {
            Ok(path) => self
                .spawn_blocking(move || {
                    let model = Model::load(&path).map_err(AppError::io)?;
                    reflect_embed::remove_other_models(&models_dir, &path);
                    Ok(model)
                })
                .await
                .map_err(|err| err.message().to_string()),
            Err(message) => Err(message),
        };

        let status = {
            let mut runtime = lock_state(&self.embed)?;
            *runtime = match loaded {
                Ok(model) => Runtime::Ready(Arc::new(Mutex::new(model))),
                Err(message) => {
                    tracing::error!(message, "embedding model load failed");
                    Runtime::Failed(message)
                }
            };
            status_of(&runtime)
        };
        emit_status(self.host(), &status);
        Ok(status)
    }

    /// Whether the model file is on disk, so `embed_ensure` loads it without a
    /// download.
    pub async fn embed_model_downloaded(&self) -> AppResult<bool> {
        if !reflect_embed::supported() {
            return Ok(false);
        }
        Ok(reflect_embed::model_downloaded(&self.models_dir()?).await)
    }

    /// Drops the context of a `Ready` model and reports `Uninitialized`. The
    /// next `embed_ensure` loads it again from the local file. The weights
    /// stay loaded for the process. An embed in progress keeps the context
    /// until it ends.
    pub fn embed_unload(&self) -> AppResult<()> {
        let status = {
            let mut runtime = lock_state(&self.embed)?;
            if !matches!(*runtime, Runtime::Ready(_)) {
                return Ok(());
            }
            *runtime = Runtime::Uninitialized;
            status_of(&runtime)
        };
        emit_status(self.host(), &status);
        Ok(())
    }

    /// Embed a search query. Errors unless the model is `Ready`.
    pub async fn embed_query(&self, text: String) -> AppResult<Vec<f32>> {
        if !reflect_embed::supported() {
            return Err(unsupported());
        }
        let model = self.ready_model()?;
        self.spawn_blocking(move || embed_one(&model, |model| model.embed_query(&text)))
            .await
    }

    /// Embeds a note's changed chunks and replaces its chunk set in the index
    /// at `generation`. Returns how many chunks it embedded. A chunk whose hash
    /// has a stored row under the runtime's model keeps its vector, so an
    /// empty set or a set of unchanged chunks needs no loaded model. Each
    /// chunk takes the model lock on its own, so a query can run between two
    /// chunks of a long note.
    pub async fn embed_note_chunks(
        &self,
        path: String,
        chunks: Vec<ChunkToEmbed>,
        generation: u64,
    ) -> AppResult<u32> {
        if !reflect_embed::supported() {
            return Err(unsupported());
        }
        // An empty set reuses nothing, and the generation-gated write drops a
        // stale removal.
        let stored = if chunks.is_empty() {
            Vec::new()
        } else {
            let read_generation = self.index.read_generation()?;
            self.repair_index(
                read_generation,
                self.index.embedding_chunk_hashes(read_generation, &path),
            )?
        };
        let reused = reused_chunks(&chunks, &stored, MODEL_ID);
        let (chunks, embedded) = if reused.contains(&false) {
            let model = self.ready_model()?;
            self.spawn_blocking(move || {
                embed_chunks(chunks, &reused, |text| {
                    embed_one(&model, |model| model.embed_document(text))
                })
            })
            .await?
        } else {
            embed_chunks(chunks, &reused, |_| unreachable!("every chunk is reused"))?
        };
        let _background_task = background_task::scoped(&self.background_tasks, "embed_note_chunks");
        let current = self.index.current_generation()?.unwrap_or(0);
        self.repair_index(
            current,
            self.index.apply_embeddings(generation, &path, &chunks),
        )?;
        Ok(embedded)
    }

    fn models_dir(&self) -> AppResult<PathBuf> {
        Ok(self
            .config
            .app_data_dir
            .as_ref()
            .ok_or_else(|| AppError::io("no app data dir"))?
            .join("models"))
    }

    fn ready_model(&self) -> AppResult<Arc<Mutex<Model>>> {
        match &*lock_state(&self.embed)? {
            Runtime::Ready(model) => Ok(Arc::clone(model)),
            _ => Err(AppError::io("embedding model is not loaded")),
        }
    }
}

/// Marks each chunk that can keep a stored vector: its hash has a stored row
/// under `model_id`. Each stored row pairs with one chunk, so duplicate chunks
/// reuse only as many rows as exist.
fn reused_chunks(chunks: &[ChunkToEmbed], stored: &[ChunkHash], model_id: &str) -> Vec<bool> {
    let mut available: HashMap<&str, usize> = HashMap::new();
    for row in stored.iter().filter(|row| row.model_id == model_id) {
        *available.entry(row.content_hash.as_str()).or_default() += 1;
    }
    chunks
        .iter()
        .map(
            |chunk| match available.get_mut(chunk.content_hash.as_str()) {
                Some(count) if *count > 0 => {
                    *count -= 1;
                    true
                }
                _ => false,
            },
        )
        .collect()
}

/// Gives each chunk that is not reused a vector from `embed`, in order, and
/// counts them. Every chunk carries the runtime's model id.
fn embed_chunks(
    chunks: Vec<ChunkToEmbed>,
    reused: &[bool],
    mut embed: impl FnMut(&str) -> AppResult<Vec<f32>>,
) -> AppResult<(Vec<EmbeddedChunk>, u32)> {
    let mut embedded = 0;
    let chunks = chunks
        .into_iter()
        .zip(reused)
        .map(|(chunk, &reused)| {
            let vector = if reused {
                None
            } else {
                embedded += 1;
                Some(embed(&chunk.text)?)
            };
            Ok(EmbeddedChunk {
                heading: chunk.heading,
                pos_from: chunk.pos_from,
                pos_to: chunk.pos_to,
                text: chunk.text,
                content_hash: chunk.content_hash,
                model_id: MODEL_ID.to_string(),
                vector,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok((chunks, embedded))
}

fn embed_one(
    model: &Mutex<Model>,
    embed: impl FnOnce(&mut Model) -> Result<Vec<f32>, String>,
) -> AppResult<Vec<f32>> {
    let mut model = model
        .lock()
        .map_err(|_| AppError::io("embedding model lock poisoned"))?;
    embed(&mut model).map_err(|err| AppError::io(format!("embedding failed: {err}")))
}

/// The error of an embed command on a platform without the runtime. The
/// frontend never embeds on an `unsupported` runtime.
fn unsupported() -> AppError {
    AppError::Unknown {
        message: "the embedding runtime is not supported on this platform".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(text: &str) -> ChunkToEmbed {
        ChunkToEmbed {
            heading: None,
            pos_from: 0,
            pos_to: text.len() as i64,
            text: text.to_string(),
            content_hash: format!("hash-{text}"),
        }
    }

    fn stored(text: &str, model_id: &str) -> ChunkHash {
        ChunkHash {
            content_hash: format!("hash-{text}"),
            model_id: model_id.to_string(),
        }
    }

    #[test]
    fn reuses_the_chunks_with_a_stored_row_under_the_model() {
        let chunks = [chunk("a"), chunk("b"), chunk("c")];
        let rows = [stored("b", "model"), stored("c", "old-model")];
        assert_eq!(reused_chunks(&chunks, &rows, "model"), [false, true, false]);
    }

    #[test]
    fn duplicate_chunks_reuse_only_as_many_rows_as_exist() {
        let chunks = [chunk("a"), chunk("a")];
        let rows = [stored("a", "model")];
        assert_eq!(reused_chunks(&chunks, &rows, "model"), [true, false]);
    }

    #[test]
    fn embeds_only_the_chunks_that_are_not_reused() {
        let mut texts = Vec::new();
        let (chunks, embedded) = embed_chunks(
            vec![chunk("a"), chunk("b"), chunk("c")],
            &[false, true, false],
            |text| {
                texts.push(text.to_string());
                Ok(vec![texts.len() as f32])
            },
        )
        .unwrap();
        assert_eq!(texts, ["a", "c"]);
        assert_eq!(embedded, 2);
        let vectors: Vec<_> = chunks.iter().map(|chunk| chunk.vector.clone()).collect();
        assert_eq!(vectors, [Some(vec![1.0]), None, Some(vec![2.0])]);
        assert!(chunks.iter().all(|chunk| chunk.model_id == MODEL_ID));
    }

    #[test]
    fn a_failed_embed_fails_the_whole_note() {
        let result = embed_chunks(vec![chunk("a")], &[false], |_| Err(AppError::io("boom")));
        assert!(result.is_err());
    }
}
