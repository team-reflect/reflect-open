//! The local embedding runtime (Plan 09): the shell's [`EmbedBackend`]
//! (llama.cpp in `reflect-embed`), off the UI thread. The model is downloaded on demand into app data, never bundled, and
//! every failure degrades to a reported "unavailable" state (the same
//! recoverable contract as sqlite-vec): semantic search is strictly additive,
//! so nothing here may ever take the app down.

mod download;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use reflect_types::{
    AppError, AppResult, ChunkHash, ChunkToEmbed, EmbedModel, EmbedProgress, EmbedStatus,
    EmbeddedChunk,
};

use crate::{Core, Host, background_task};

/// What to download and how to run it.
struct ModelSpec {
    /// Recorded per chunk row; the TS hash-skip keys on it, so a new id
    /// re-embeds every note.
    id: &'static str,
    repo: &'static str,
    revision: &'static str,
    file: &'static str,
    size: u64,
    sha256: &'static str,
    /// Leading dimensions kept (Matryoshka truncation), then re-normalized.
    dims: usize,
    /// The context window. Longer inputs are truncated.
    max_tokens: u32,
    query_prompt: &'static str,
    document_prompt: &'static str,
}

/// EmbeddingGemma 300M, Q8_0. The prompts and the Matryoshka truncation follow
/// the model card: https://huggingface.co/google/embeddinggemma-300m
/// EmbeddingGemma 2 is not used: it retrieves English text less well, in
/// Google's results and in ours. See `docs/decisions/0006-llama-cpp-embeddings.md`.
const MODEL: ModelSpec = ModelSpec {
    id: "embeddinggemma-300m-q8_0-d256",
    repo: "ggml-org/embeddinggemma-300M-GGUF",
    revision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
    file: "embeddinggemma-300M-Q8_0.gguf",
    size: 333_590_944,
    sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
    dims: reflect_index_schema::EMBEDDING_DIMS,
    max_tokens: 2048,
    query_prompt: "task: search result | query: ",
    document_prompt: "title: none | text: ",
};

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
    Ready(Arc<Mutex<Box<dyn EmbedModel>>>),
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
            model: MODEL.id.to_string(),
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
        total: MODEL.size,
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

/// The model's URL; `HF_ENDPOINT` points it at a mirror.
fn model_url() -> String {
    let endpoint =
        std::env::var("HF_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".to_string());
    format!(
        "{}/{}/resolve/{}/{}",
        endpoint.trim_end_matches('/'),
        MODEL.repo,
        MODEL.revision,
        MODEL.file
    )
}

/// The model file in `models_dir`. The revision in the name keeps a new model
/// spec from reusing an old file.
fn model_path(models_dir: &Path) -> PathBuf {
    models_dir.join(format!("{}-{}", &MODEL.revision[..12], MODEL.file))
}

/// Whether `path` holds the whole model. A file of another size is damaged.
async fn model_file_complete(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|meta| meta.len() == MODEL.size)
}

/// The model file in `models_dir`, downloaded first unless it is there.
async fn ensure_model_file(
    host: &dyn Host,
    state: &Mutex<Runtime>,
    models_dir: &Path,
) -> Result<PathBuf, String> {
    let path = model_path(models_dir);
    if model_file_complete(&path).await {
        return Ok(path);
    }
    let url = model_url();
    let mut emitted: Option<u64> = None;
    download::fetch(
        &download::Download {
            url: &url,
            size: MODEL.size,
            sha256: MODEL.sha256,
        },
        &path,
        |downloaded| {
            // `abs_diff`: the count drops to zero when the server ignores the
            // resume range and the download starts over.
            let due = emitted.is_none_or(|last| {
                downloaded.abs_diff(last) >= PROGRESS_EMIT_STEP || downloaded == MODEL.size
            });
            if due {
                emitted = Some(downloaded);
                report_progress(host, state, downloaded);
            }
        },
    )
    .await?;
    Ok(path)
}

/// Delete everything in `models_dir` except `keep`: the caches of the replaced
/// ONNX runtime and the files of older model specs. The directory belongs to
/// this runtime. Failures only cost disk space.
fn remove_other_models(models_dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(models_dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        if path == keep {
            continue;
        }
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match removed {
            Ok(()) => tracing::info!(path = %path.display(), "removed an old model file"),
            Err(err) => tracing::warn!(?err, path = %path.display(), "old model file"),
        }
    }
}

impl Core {
    /// Current runtime status (poll on startup; live changes arrive on
    /// `embed:status` events).
    pub fn embed_status(&self) -> AppResult<EmbedStatus> {
        if self.config.embed_backend.is_none() {
            return Ok(EmbedStatus::Unsupported);
        }
        Ok(status_of(&*lock_state(&self.embed)?))
    }

    /// Ensure the model is loaded, downloading it on first use. Idempotent: a
    /// concurrent call while loading returns immediately (the event stream
    /// carries the outcome). A failed download resumes on the next call.
    pub async fn embed_ensure(&self) -> AppResult<EmbedStatus> {
        let Some(backend) = self.config.embed_backend.clone() else {
            return Ok(EmbedStatus::Unsupported);
        };
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
                    let model = backend
                        .load(&path, MODEL.max_tokens)
                        .map_err(AppError::io)?;
                    remove_other_models(&models_dir, &path);
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
        if self.config.embed_backend.is_none() {
            return Ok(false);
        }
        Ok(model_file_complete(&model_path(&self.models_dir()?)).await)
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
        if self.config.embed_backend.is_none() {
            return Err(unsupported());
        }
        let model = self.ready_model()?;
        self.spawn_blocking(move || embed_one(&model, MODEL.query_prompt, &text))
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
        if self.config.embed_backend.is_none() {
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
        let reused = reused_chunks(&chunks, &stored, MODEL.id);
        let (chunks, embedded) = if reused.contains(&false) {
            let model = self.ready_model()?;
            self.spawn_blocking(move || {
                embed_chunks(chunks, &reused, |text| {
                    embed_one(&model, MODEL.document_prompt, text)
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

    fn ready_model(&self) -> AppResult<Arc<Mutex<Box<dyn EmbedModel>>>> {
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
                model_id: MODEL.id.to_string(),
                vector,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok((chunks, embedded))
}

fn embed_one(model: &Mutex<Box<dyn EmbedModel>>, prompt: &str, text: &str) -> AppResult<Vec<f32>> {
    let full = model
        .lock()
        .map_err(|_| AppError::io("embedding model lock poisoned"))?
        .embed(prompt, text)
        .map_err(|err| AppError::io(format!("embedding failed: {err}")))?;
    truncate_and_normalize(&full, MODEL.dims)
}

/// The leading `dims` of `full` (Matryoshka truncation), scaled to a unit
/// vector.
fn truncate_and_normalize(full: &[f32], dims: usize) -> AppResult<Vec<f32>> {
    let mut vector = full
        .get(..dims)
        .ok_or_else(|| {
            AppError::io(format!(
                "embedding failed: the model returned {} dimensions",
                full.len()
            ))
        })?
        .to_vec();
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        vector.iter_mut().for_each(|value| *value /= norm);
    }
    Ok(vector)
}

/// The error of an embed command when the shell passed no backend. The
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
        assert!(chunks.iter().all(|chunk| chunk.model_id == MODEL.id));
    }

    #[test]
    fn a_failed_embed_fails_the_whole_note() {
        let result = embed_chunks(vec![chunk("a")], &[false], |_| Err(AppError::io("boom")));
        assert!(result.is_err());
    }

    #[test]
    fn keeps_the_leading_dimensions_as_a_unit_vector() {
        assert_eq!(
            truncate_and_normalize(&[3.0, 4.0, 9.0], 2).unwrap(),
            [0.6, 0.8]
        );
        assert!(truncate_and_normalize(&[1.0], 2).is_err());
    }
}
