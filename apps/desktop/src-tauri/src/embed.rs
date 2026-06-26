//! The local embedding runtime (Plan 09): fastembed (ONNX) in-process, off the
//! UI thread. The model (all-MiniLM-L6-v2, 384-dim) is downloaded on demand
//! into app data — never bundled — and every failure degrades to a reported
//! "unavailable" state (the same recoverable contract as sqlite-vec): semantic
//! search is strictly additive, so nothing here may ever take the app down.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use hf_hub::api::sync::ApiBuilder;
use hf_hub::api::Progress;
use hf_hub::Cache;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};

/// Identifier recorded per vector; changing the model bumps this and triggers
/// an embedding rebuild (`index_meta.embeddingModel` comparison in TS).
pub const MODEL_ID: &str = "all-MiniLM-L6-v2";

/// The hf-hub repo and files fastembed resolves for `AllMiniLML6V2`. Mirrored
/// here so the pre-download (the progress-reporting path) fills the exact
/// cache `try_new` reads. If fastembed ever changes its file set, the only
/// cost is that it downloads the difference itself — without progress.
const MODEL_REPO: &str = "Qdrant/all-MiniLM-L6-v2-onnx";
const MODEL_FILES: [&str; 5] = [
    "model.onnx",
    "tokenizer.json",
    "config.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
];
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const ONNX_RUNTIME_DYLIB_RESOURCE: &str = "libonnxruntime.dylib";

/// Byte counts for an active model download. Absent until the download
/// starts (cache probing, or a cached model that skips downloading); after
/// the last byte it stays at 100% through the model-load phase.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteProgress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum EmbedStatus {
    /// No model loaded yet; `embed_ensure` will download/load it.
    Uninitialized,
    /// Download/load in progress (first run downloads ~90MB). The runtime
    /// keeps the latest byte counts, so polls and `embed:status` events
    /// report the same progress.
    Loading {
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<ByteProgress>,
    },
    /// `embed_texts` is ready; `model` is recorded per vector (rebuild key).
    Ready { model: String },
    /// Load failed; semantic search is unavailable (lexical still works).
    Failed { message: String },
}

#[derive(Default)]
enum Runtime {
    #[default]
    Uninitialized,
    Loading {
        progress: Option<ByteProgress>,
    },
    // fastembed's `embed` takes `&mut self`, so the model sits behind its own
    // Mutex — embed calls serialize, which batching makes irrelevant.
    Ready(Arc<Mutex<TextEmbedding>>),
    Failed(String),
}

/// Process-wide embedding runtime state.
#[derive(Default)]
pub struct EmbedState(Mutex<Runtime>);

fn lock_state<'a>(
    state: &'a State<'a, EmbedState>,
) -> AppResult<std::sync::MutexGuard<'a, Runtime>> {
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

fn emit_status(app: &AppHandle, status: &EmbedStatus) {
    let _ = app.emit("embed:status", status);
}

/// Record download progress on the runtime state, so an `embed_status` poll
/// (e.g. a UI surface mounted mid-download) reports the same bytes as the
/// `embed:status` events. Only an in-flight load is updated — by the time a
/// stale progress callback could land, the state owns a terminal status.
fn store_progress(app: &AppHandle, progress: ByteProgress) {
    let state = app.state::<EmbedState>();
    let Ok(mut runtime) = state.0.lock() else {
        return;
    };
    if matches!(*runtime, Runtime::Loading { .. }) {
        *runtime = Runtime::Loading {
            progress: Some(progress),
        };
    }
}

/// How many newly-downloaded bytes accumulate between progress events — about
/// ninety events for the full model, comfortably few for the IPC channel yet
/// smooth enough for a progress bar.
const PROGRESS_EMIT_STEP: u64 = 1024 * 1024;

struct DownloadState {
    app: AppHandle,
    downloaded: u64,
    total: u64,
    emitted: u64,
}

impl DownloadState {
    fn emit(&mut self) {
        self.emitted = self.downloaded;
        let progress = ByteProgress {
            downloaded: self.downloaded,
            total: self.total,
        };
        store_progress(&self.app, progress);
        emit_status(
            &self.app,
            &EmbedStatus::Loading {
                progress: Some(progress),
            },
        );
    }
}

/// Cumulative byte progress across the whole file set, surfaced as
/// `embed:status` events. hf-hub takes the reporter by value per file, so the
/// shared tally lives behind an `Arc` and each download gets a clone.
#[derive(Clone)]
struct DownloadProgress(Arc<Mutex<DownloadState>>);

impl DownloadProgress {
    fn new(app: AppHandle, total: u64) -> Self {
        let mut state = DownloadState {
            app,
            downloaded: 0,
            total,
            emitted: 0,
        };
        // Surface the total before the first chunk lands, so the bar starts
        // at a real 0% instead of indeterminate.
        state.emit();
        Self(Arc::new(Mutex::new(state)))
    }
}

impl Progress for DownloadProgress {
    fn init(&mut self, _size: usize, _filename: &str) {}

    fn update(&mut self, size: usize) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        state.downloaded += size as u64;
        if state.downloaded - state.emitted >= PROGRESS_EMIT_STEP || state.downloaded >= state.total
        {
            state.emit();
        }
    }

    fn finish(&mut self) {}
}

/// Fetch whatever model files are missing from the cache, with byte progress.
/// fastembed downloads these itself inside `try_new`, but silently; fetching
/// them first through the same hf-hub cache gives the UI a real progress bar
/// and leaves `try_new` a pure cache hit. Mirrors fastembed's resolution —
/// env overrides included — so both sides agree on location and endpoint.
fn download_model_files(app: &AppHandle, cache_dir: &Path) -> Result<(), String> {
    let cache_dir = std::env::var("HF_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| cache_dir.to_path_buf());
    let endpoint =
        std::env::var("HF_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".to_string());

    let cached = Cache::new(cache_dir.clone()).model(MODEL_REPO.to_string());
    let missing: Vec<&str> = MODEL_FILES
        .iter()
        .copied()
        .filter(|file| cached.get(file).is_none())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }

    let api = ApiBuilder::new()
        .with_cache_dir(cache_dir)
        .with_endpoint(endpoint)
        .build()
        .map_err(|err| format!("hf-hub api: {err}"))?;
    let repo = api.model(MODEL_REPO.to_string());

    // Size every missing file up front (HEAD-weight requests, ~nothing next
    // to the 90MB body) so the bar tracks one stable total instead of
    // restarting per file.
    let mut total: u64 = 0;
    for file in &missing {
        total += api
            .metadata(&repo.url(file))
            .map_err(|err| format!("sizing {file}: {err}"))?
            .size() as u64;
    }

    let progress = DownloadProgress::new(app.clone(), total);
    for file in missing {
        repo.download_with_progress(file, progress.clone())
            .map_err(|err| format!("downloading {file}: {err}"))?;
    }
    Ok(())
}

fn configure_onnx_runtime(app: &AppHandle) -> Result<(), String> {
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        let dylib = app
            .path()
            .resource_dir()
            .map_err(|err| format!("locating app resources: {err}"))?
            .join(ONNX_RUNTIME_DYLIB_RESOURCE);
        if !dylib.exists() {
            return Err(format!(
                "ONNX Runtime library is missing from app resources: {}",
                dylib.display()
            ));
        }
        let committed = ort::init_from(&dylib)
            .map_err(|err| format!("loading ONNX Runtime from {}: {err}", dylib.display()))?
            .commit();
        if committed {
            tracing::info!(path = %dylib.display(), "loaded bundled ONNX Runtime");
        }
    }
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        let _ = app;
    }
    Ok(())
}

/// Current runtime status (poll on startup; live changes arrive on
/// `embed:status` events).
#[tauri::command]
pub fn embed_status(state: State<EmbedState>) -> AppResult<EmbedStatus> {
    Ok(status_of(&*lock_state(&state)?))
}

/// Ensure the model is loaded, downloading it on first use. Idempotent: a
/// concurrent call while loading returns immediately (the event stream carries
/// the outcome). Runs the load on a blocking thread — model init is seconds
/// even when cached, and the first run downloads.
#[tauri::command]
pub async fn embed_ensure(app: AppHandle, state: State<'_, EmbedState>) -> AppResult<EmbedStatus> {
    // Resolve the cache dir BEFORE flipping to Loading: it's the only step
    // here that may fail without a guaranteed state transition afterwards.
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::io(format!("no app data dir: {err}")))?
        .join("models");

    {
        let mut runtime = lock_state(&state)?;
        match &*runtime {
            Runtime::Ready(_) | Runtime::Loading { .. } => return Ok(status_of(&runtime)),
            Runtime::Uninitialized | Runtime::Failed(_) => {
                *runtime = Runtime::Loading { progress: None };
            }
        }
    }
    emit_status(&app, &EmbedStatus::Loading { progress: None });

    // From here every path — success, load failure, even a panicked blocking
    // task — must land the state in Ready or Failed: an early `?` would wedge
    // the runtime in Loading forever (later ensures return early on Loading).
    let app_for_progress = app.clone();
    let loaded: Result<TextEmbedding, String> =
        match tauri::async_runtime::spawn_blocking(move || {
            configure_onnx_runtime(&app_for_progress)?;
            download_model_files(&app_for_progress, &cache_dir)?;
            TextEmbedding::try_new(
                InitOptions::new(EmbeddingModel::AllMiniLML6V2).with_cache_dir(cache_dir),
            )
            .map_err(|err| err.to_string())
        })
        .await
        {
            Ok(result) => result,
            Err(err) => Err(format!("embedding load task panicked: {err}")),
        };

    let status = {
        let mut runtime = lock_state(&state)?;
        *runtime = match loaded {
            Ok(model) => Runtime::Ready(Arc::new(Mutex::new(model))),
            Err(message) => {
                tracing::error!(message, "embedding model load failed");
                Runtime::Failed(message)
            }
        };
        status_of(&runtime)
    };
    emit_status(&app, &status);
    Ok(status)
}

/// Embed a batch of texts → 384-dim vectors, off the UI thread. Errors if the
/// model isn't `Ready` (callers gate on `embed_status`/`embed_ensure`).
#[tauri::command]
pub async fn embed_texts(
    texts: Vec<String>,
    state: State<'_, EmbedState>,
) -> AppResult<Vec<Vec<f32>>> {
    let model = {
        let runtime = lock_state(&state)?;
        match &*runtime {
            Runtime::Ready(model) => Arc::clone(model),
            _ => return Err(AppError::io("embedding model is not loaded")),
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut model = model
            .lock()
            .map_err(|_| AppError::io("embedding model lock poisoned"))?;
        model
            .embed(texts, None)
            .map_err(|err| AppError::io(format!("embedding failed: {err}")))
    })
    .await
    .map_err(|err| AppError::io(format!("embedding task panicked: {err}")))?
}
