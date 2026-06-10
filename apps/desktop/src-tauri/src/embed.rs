//! The local embedding runtime (Plan 09): fastembed (ONNX) in-process, off the
//! UI thread. The model (all-MiniLM-L6-v2, 384-dim) is downloaded on demand
//! into app data — never bundled — and every failure degrades to a reported
//! "unavailable" state (the same recoverable contract as sqlite-vec): semantic
//! search is strictly additive, so nothing here may ever take the app down.

use std::sync::{Arc, Mutex};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};

/// Identifier recorded per vector; changing the model bumps this and triggers
/// an embedding rebuild (`index_meta.embeddingModel` comparison in TS).
pub const MODEL_ID: &str = "all-MiniLM-L6-v2";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum EmbedStatus {
    /// No model loaded yet; `embed_ensure` will download/load it.
    Uninitialized,
    /// Download/load in progress (first run downloads ~90MB).
    Loading,
    /// `embed_texts` is ready; `model` is recorded per vector (rebuild key).
    Ready { model: String },
    /// Load failed; semantic search is unavailable (lexical still works).
    Failed { message: String },
}

#[derive(Default)]
enum Runtime {
    #[default]
    Uninitialized,
    Loading,
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
        Runtime::Loading => EmbedStatus::Loading,
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
            Runtime::Ready(_) | Runtime::Loading => return Ok(status_of(&runtime)),
            Runtime::Uninitialized | Runtime::Failed(_) => {
                *runtime = Runtime::Loading;
            }
        }
    }
    emit_status(&app, &EmbedStatus::Loading);

    // From here every path — success, load failure, even a panicked blocking
    // task — must land the state in Ready or Failed: an early `?` would wedge
    // the runtime in Loading forever (later ensures return early on Loading).
    let loaded: Result<TextEmbedding, String> =
        match tauri::async_runtime::spawn_blocking(move || {
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
