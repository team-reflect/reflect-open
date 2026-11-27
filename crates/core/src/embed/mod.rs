//! The local embedding runtime (Plan 09): llama.cpp in-process, off the UI
//! thread. The model is downloaded on demand into app data, never bundled, and
//! every failure degrades to a reported "unavailable" state (the same
//! recoverable contract as sqlite-vec): semantic search is strictly additive,
//! so nothing here may ever take the app down.

mod download;

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::model::params::LlamaModelParams;
use reflect_types::{AppError, AppResult, EmbedProgress, EmbedStatus};

use crate::{Core, Host};

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
    /// Longer inputs are truncated.
    max_tokens: usize,
    query_prompt: &'static str,
    document_prompt: &'static str,
}

/// EmbeddingGemma 300M, Q8_0. The prompts and the 256-dim truncation follow
/// the model card: https://huggingface.co/google/embeddinggemma-300m
const MODEL: ModelSpec = ModelSpec {
    id: "embeddinggemma-300m-q8_0-d256",
    repo: "ggml-org/embeddinggemma-300M-GGUF",
    revision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
    file: "embeddinggemma-300M-Q8_0.gguf",
    size: 333_590_944,
    sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
    dims: 256,
    max_tokens: 512,
    query_prompt: "task: search result | query: ",
    document_prompt: "title: none | text: ",
};

/// Model caches of the ONNX runtime that this one replaced, inside the models
/// directory. Deleted once the new model is ready.
const LEGACY_CACHE_DIRS: [&str; 2] = [
    "models--Qdrant--all-MiniLM-L6-v2-onnx",
    ".locks/models--Qdrant--all-MiniLM-L6-v2-onnx",
];

/// CPU threads per embed. A call embeds one note (two or three chunks), so
/// more threads mostly wait on each other.
const THREADS: i32 = 2;

/// Layers offloaded to the GPU: all of them on Apple Silicon (Metal), none
/// elsewhere.
const GPU_LAYERS: u32 = if cfg!(target_os = "macos") { 99 } else { 0 };

/// How many newly downloaded bytes accumulate between progress events: about
/// three hundred events for the model, few for the IPC channel yet smooth
/// enough for a progress bar.
const PROGRESS_EMIT_STEP: u64 = 1024 * 1024;

/// A loaded model and its one context. Embed calls serialize on the Mutex
/// around it.
struct Model {
    // Declared first so it drops first: it borrows `model`.
    context: LlamaContext<'static>,
    model: Box<LlamaModel>,
}

// SAFETY: llama.cpp allows a context to move between threads; it is only used
// behind the runtime's Mutex, so one thread at a time.
unsafe impl Send for Model {}

/// llama.cpp's process-wide backend, initialized once.
fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            let mut backend = LlamaBackend::init().map_err(|err| err.to_string())?;
            // Load and embed failures come back as errors; the log is noise.
            backend.void_logs();
            Ok(backend)
        })
        .as_ref()
        .map_err(Clone::clone)
}

impl Model {
    fn load(path: &Path) -> Result<Self, String> {
        let backend = backend()?;
        let params = LlamaModelParams::default().with_n_gpu_layers(GPU_LAYERS);
        let model = Box::new(
            LlamaModel::load_from_file(backend, path, &params).map_err(|err| err.to_string())?,
        );
        // SAFETY: the box keeps the model at one address until `Model` drops,
        // and `context` drops before `model` (field order).
        let model_ref: &'static LlamaModel = unsafe { &*std::ptr::from_ref(model.as_ref()) };
        let max_tokens = MODEL.max_tokens as u32;
        let context = model_ref
            .new_context(
                backend,
                LlamaContextParams::default()
                    .with_embeddings(true)
                    .with_pooling_type(LlamaPoolingType::Mean)
                    .with_n_ctx(NonZeroU32::new(max_tokens))
                    .with_n_batch(max_tokens)
                    .with_n_ubatch(max_tokens)
                    .with_n_threads(THREADS)
                    .with_n_threads_batch(THREADS),
            )
            .map_err(|err| err.to_string())?;
        Ok(Self { context, model })
    }

    /// One unit vector of `MODEL.dims` for `prompt` followed by `text`.
    fn embed(&mut self, prompt: &str, text: &str) -> Result<Vec<f32>, String> {
        let input = format!("{prompt}{text}");
        let mut tokens = self.model.vocab().tokenize(input.as_bytes(), true, false);
        tokens.truncate(MODEL.max_tokens);
        self.context.clear_kv_cache();
        let mut batch = LlamaBatch::new(tokens.len().max(1), 1);
        batch
            .add_sequence(&tokens, 0, false)
            .map_err(|err| err.to_string())?;
        self.context
            .decode(&mut batch)
            .map_err(|err| err.to_string())?;
        let full = self
            .context
            .embeddings_seq_ith(0)
            .map_err(|err| err.to_string())?;
        let mut vector = full
            .get(..MODEL.dims)
            .ok_or_else(|| format!("the model returned {} dimensions", full.len()))?
            .to_vec();
        let norm = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            vector.iter_mut().for_each(|x| *x /= norm);
        }
        Ok(vector)
    }
}

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
pub struct EmbedState(Arc<Mutex<Runtime>>);

/// ggml's x86_64 kernels are built for AVX2, FMA and F16C (`.cargo/config.toml`).
/// Without them the first embed dies with SIGILL, which no error path can
/// catch, so check before loading and report `unsupported` instead.
#[cfg(target_arch = "x86_64")]
fn cpu_supported() -> bool {
    std::is_x86_feature_detected!("avx2")
        && std::is_x86_feature_detected!("fma")
        && std::is_x86_feature_detected!("f16c")
}

#[cfg(not(target_arch = "x86_64"))]
fn cpu_supported() -> bool {
    true
}

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

/// The model file in `models_dir`, downloaded first unless it is there.
async fn ensure_model_file(
    host: &dyn Host,
    state: &Mutex<Runtime>,
    models_dir: &Path,
) -> Result<PathBuf, String> {
    let path = models_dir.join(format!("{}.gguf", MODEL.id));
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
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
            let due = emitted.is_none_or(|last| {
                downloaded.abs_diff(last) >= PROGRESS_EMIT_STEP || downloaded == MODEL.size
            });
            if due && emitted != Some(downloaded) {
                emitted = Some(downloaded);
                report_progress(host, state, downloaded);
            }
        },
    )
    .await?;
    Ok(path)
}

/// Delete the replaced runtime's caches. Failures only cost disk space.
fn remove_legacy_caches(models_dir: &Path) {
    for dir in LEGACY_CACHE_DIRS {
        let path = models_dir.join(dir);
        match std::fs::remove_dir_all(&path) {
            Ok(()) => tracing::info!(path = %path.display(), "removed a legacy model cache"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => tracing::warn!(?err, path = %path.display(), "legacy model cache"),
        }
    }
}

impl Core {
    /// Current runtime status (poll on startup; live changes arrive on
    /// `embed:status` events).
    pub fn embed_status(&self) -> AppResult<EmbedStatus> {
        if !cpu_supported() {
            return Ok(EmbedStatus::Unsupported);
        }
        Ok(status_of(&*lock_state(&self.embed)?))
    }

    /// Ensure the model is loaded, downloading it on first use. Idempotent: a
    /// concurrent call while loading returns immediately (the event stream
    /// carries the outcome). A failed download resumes on the next call.
    pub async fn embed_ensure(&self) -> AppResult<EmbedStatus> {
        if !cpu_supported() {
            return Ok(EmbedStatus::Unsupported);
        }
        // Resolve the directory BEFORE flipping to Loading: it's the only step
        // here that may fail without a guaranteed state transition afterwards.
        let models_dir = self
            .config
            .app_data_dir
            .as_ref()
            .ok_or_else(|| AppError::io("no app data dir"))?
            .join("models");

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
                .runtime
                .spawn_blocking(move || {
                    let model = Model::load(&path)?;
                    remove_legacy_caches(&models_dir);
                    Ok(model)
                })
                .await
                .unwrap_or_else(|err| Err(format!("embedding load task panicked: {err}"))),
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

    /// Embed a search query. Errors unless the model is `Ready`.
    pub async fn embed_query(&self, text: String) -> AppResult<Vec<f32>> {
        let mut vectors = self.embed_with(MODEL.query_prompt, vec![text]).await?;
        vectors
            .pop()
            .ok_or_else(|| AppError::io("embedding returned no vector"))
    }

    /// Embed note chunks for storage. Errors unless the model is `Ready`.
    pub async fn embed_documents(&self, texts: Vec<String>) -> AppResult<Vec<Vec<f32>>> {
        self.embed_with(MODEL.document_prompt, texts).await
    }

    async fn embed_with(
        &self,
        prompt: &'static str,
        texts: Vec<String>,
    ) -> AppResult<Vec<Vec<f32>>> {
        let model = {
            let runtime = lock_state(&self.embed)?;
            match &*runtime {
                Runtime::Ready(model) => Arc::clone(model),
                _ => return Err(AppError::io("embedding model is not loaded")),
            }
        };
        self.runtime
            .spawn_blocking(move || {
                let mut model = model
                    .lock()
                    .map_err(|_| AppError::io("embedding model lock poisoned"))?;
                texts
                    .iter()
                    .map(|text| {
                        model
                            .embed(prompt, text)
                            .map_err(|err| AppError::io(format!("embedding failed: {err}")))
                    })
                    .collect()
            })
            .await
            .map_err(|err| AppError::io(format!("embedding task panicked: {err}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the model file: `REFLECT_EMBED_MODEL=/path/to/model.gguf cargo test
    /// -p reflect-core -- --ignored embeds_with_the_real_model`.
    #[test]
    #[ignore = "needs the model file"]
    fn embeds_with_the_real_model() {
        let path = std::env::var("REFLECT_EMBED_MODEL").expect("REFLECT_EMBED_MODEL");
        let mut model = Model::load(Path::new(&path)).unwrap();
        let first = model.embed(MODEL.document_prompt, "Notes about gardening").unwrap();
        let again = model.embed(MODEL.document_prompt, "Notes about gardening").unwrap();
        let query = model.embed(MODEL.query_prompt, "Notes about gardening").unwrap();
        assert_eq!(first.len(), MODEL.dims);
        let norm = first.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "norm {norm}");
        assert_eq!(first, again);
        assert_ne!(first, query);
    }
}
