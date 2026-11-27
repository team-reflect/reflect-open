//! The local embedding runtime (Plan 09): llama.cpp in-process, off the UI
//! thread. The model is downloaded on demand into app data, never bundled, and
//! every failure degrades to a reported "unavailable" state (the same
//! recoverable contract as sqlite-vec): semantic search is strictly additive,
//! so nothing here may ever take the app down.

mod download;

use std::ffi::{CStr, c_char, c_void};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_sys_2::{GGML_LOG_LEVEL_ERROR, GGML_LOG_LEVEL_WARN, ggml_log_level};
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

/// CPU threads per embed. Embedding is background work, so it leaves most
/// cores to the app.
const THREADS: i32 = 2;

/// How many newly downloaded bytes accumulate between progress events, so the
/// IPC channel carries few events and the progress bar still moves smoothly.
const PROGRESS_EMIT_STEP: u64 = 1024 * 1024;

/// The loaded model and its one context. Embed calls serialize on the Mutex
/// around it.
struct Model {
    model: &'static LlamaModel,
    context: LlamaContext<'static>,
}

/// Forwards llama.cpp's warnings and errors to the app log and drops the rest.
/// A failed load or context creation returns no reason, so the log is the
/// only place that has it.
unsafe extern "C" fn log_warnings(level: ggml_log_level, text: *const c_char, _: *mut c_void) {
    if level != GGML_LOG_LEVEL_WARN && level != GGML_LOG_LEVEL_ERROR {
        return;
    }
    // SAFETY: llama.cpp passes a NUL-terminated string that lives for the call.
    let text = unsafe { CStr::from_ptr(text) }.to_string_lossy();
    let text = text.trim_end();
    if level == GGML_LOG_LEVEL_ERROR {
        tracing::error!(target: "llama.cpp", "{text}");
    } else {
        tracing::warn!(target: "llama.cpp", "{text}");
    }
}

/// llama.cpp's backend, with its log routed to [`log_warnings`].
/// `LlamaBackend::init` succeeds only on its first call, so the first result
/// is kept.
fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            // SAFETY: the callback is a plain function that reads only its
            // arguments. llama.cpp also routes ggml's log through it.
            unsafe { llama_cpp_sys_2::llama_log_set(Some(log_warnings), std::ptr::null_mut()) };
            LlamaBackend::init().map_err(|err| err.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The model weights, loaded once and kept for the process, so the context can
/// borrow them for `'static` and a retry after a failed context reuses them.
fn load_weights(backend: &LlamaBackend, path: &Path) -> Result<&'static LlamaModel, String> {
    static WEIGHTS: OnceLock<LlamaModel> = OnceLock::new();
    if let Some(weights) = WEIGHTS.get() {
        return Ok(weights);
    }
    // The default offloads every layer to the GPU backend, which only the
    // Apple Silicon build has (Metal). Other builds run on the CPU.
    let weights = LlamaModel::load_from_file(backend, path, &LlamaModelParams::default())
        .map_err(|err| err.to_string())?;
    Ok(WEIGHTS.get_or_init(|| weights))
}

impl Model {
    fn load(path: &Path) -> Result<Self, String> {
        let backend = backend()?;
        let model = load_weights(backend, path)?;
        let max_tokens = MODEL.max_tokens;
        let context = model
            .new_context(
                backend,
                LlamaContextParams::default()
                    .with_embeddings(true)
                    .with_pooling_type(LlamaPoolingType::Mean)
                    .with_n_ctx(NonZeroU32::new(max_tokens))
                    .with_n_batch(max_tokens)
                    .with_n_ubatch(max_tokens)
                    // An encode of more than one token runs on the batch
                    // threads, and every input has at least BOS and EOS.
                    .with_n_threads_batch(THREADS),
            )
            .map_err(|err| err.to_string())?;
        Ok(Self { model, context })
    }

    /// One unit vector of `MODEL.dims` for `prompt` followed by `text`.
    fn embed(&mut self, prompt: &str, text: &str) -> Result<Vec<f32>, String> {
        let input = format!("{prompt}{text}");
        let vocab = self.model.vocab();
        let mut tokens = vocab.tokenize(input.as_bytes(), true, false);
        // ggml aborts the process when a batch is larger than `n_ubatch`, so
        // the input must fit the window. The cut keeps the closing EOS token.
        let max = MODEL.max_tokens as usize;
        if tokens.len() > max {
            let eos = vocab.should_add_eos().then(|| vocab.eos());
            tokens.truncate(max - usize::from(eos.is_some()));
            tokens.extend(eos);
        }
        let mut batch = LlamaBatch::new(tokens.len(), 1);
        batch
            .add_sequence(&tokens, 0, false)
            .map_err(|err| err.to_string())?;
        self.context
            .encode(&mut batch)
            .map_err(|err| err.to_string())?;
        let full = self
            .context
            .embeddings_seq_ith(0)
            .map_err(|err| err.to_string())?;
        let mut vector = full
            .get(..MODEL.dims)
            .ok_or_else(|| format!("the model returned {} dimensions", full.len()))?
            .to_vec();
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm > 0.0 {
            vector.iter_mut().for_each(|value| *value /= norm);
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
pub struct EmbedState(Mutex<Runtime>);

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
    // The revision in the name keeps a new model spec from reusing an old file.
    let path = models_dir.join(format!("{}-{}", &MODEL.revision[..12], MODEL.file));
    // A file of another size is damaged: download it again.
    let existing = tokio::fs::metadata(&path).await.map(|meta| meta.len());
    if existing.is_ok_and(|len| len == MODEL.size) {
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
                .spawn_blocking(move || {
                    let model = Model::load(&path).map_err(AppError::io)?;
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

    /// Embed a search query. Errors unless the model is `Ready`.
    pub async fn embed_query(&self, text: String) -> AppResult<Vec<f32>> {
        let model = self.ready_model()?;
        self.spawn_blocking(move || embed_one(&model, MODEL.query_prompt, &text))
            .await
    }

    /// Embed note chunks for storage. Errors unless the model is `Ready`.
    /// Each chunk takes the model lock on its own, so a query can run between
    /// two chunks of a long note.
    pub async fn embed_documents(&self, texts: Vec<String>) -> AppResult<Vec<Vec<f32>>> {
        let model = self.ready_model()?;
        self.spawn_blocking(move || {
            texts
                .iter()
                .map(|text| embed_one(&model, MODEL.document_prompt, text))
                .collect()
        })
        .await
    }

    fn ready_model(&self) -> AppResult<Arc<Mutex<Model>>> {
        match &*lock_state(&self.embed)? {
            Runtime::Ready(model) => Ok(Arc::clone(model)),
            _ => Err(AppError::io("embedding model is not loaded")),
        }
    }
}

fn embed_one(model: &Mutex<Model>, prompt: &str, text: &str) -> AppResult<Vec<f32>> {
    model
        .lock()
        .map_err(|_| AppError::io("embedding model lock poisoned"))?
        .embed(prompt, text)
        .map_err(|err| AppError::io(format!("embedding failed: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the model file: `REFLECT_EMBED_MODEL=/path/to/model.gguf
    /// GGML_METAL_NO_RESIDENCY=1 cargo test -p reflect-core -- --ignored
    /// embeds_with_the_real_model`. On macOS the variable keeps ggml from
    /// aborting at exit, as in the app's `main`.
    #[test]
    #[ignore = "needs the model file"]
    fn embeds_with_the_real_model() {
        let path = std::env::var("REFLECT_EMBED_MODEL").expect("REFLECT_EMBED_MODEL");
        let mut model = Model::load(Path::new(&path)).unwrap();
        let first = model
            .embed(MODEL.document_prompt, "Notes about gardening")
            .unwrap();
        let again = model
            .embed(MODEL.document_prompt, "Notes about gardening")
            .unwrap();
        let query = model
            .embed(MODEL.query_prompt, "Notes about gardening")
            .unwrap();
        assert_eq!(first.len(), MODEL.dims);
        let norm = first.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "norm {norm}");
        assert_eq!(first, again);
        assert_ne!(first, query);
        let long = model
            .embed(MODEL.document_prompt, &"word ".repeat(5000))
            .unwrap();
        assert_eq!(long.len(), MODEL.dims);
    }
}
