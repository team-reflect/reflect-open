//! llama.cpp in-process. The weights load once per process; each [`Model`]
//! is one context over them.

use std::ffi::{CStr, c_char, c_void};
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::OnceLock;

use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_sys_2::{GGML_LOG_LEVEL_ERROR, GGML_LOG_LEVEL_WARN, ggml_log_level};

use crate::{MODEL, truncate_and_normalize};

/// CPU threads per embed. Embedding is background work, so it leaves most
/// cores to the app.
const THREADS: i32 = 2;

/// The loaded model and its one context.
pub struct Model {
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
    /// Loads the model file at `path`.
    pub fn load(path: &Path) -> Result<Self, String> {
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

    /// The unit vector of a search query.
    pub fn embed_query(&mut self, text: &str) -> Result<Vec<f32>, String> {
        self.embed(MODEL.query_prompt, text)
    }

    /// The unit vector of a note chunk.
    pub fn embed_document(&mut self, text: &str) -> Result<Vec<f32>, String> {
        self.embed(MODEL.document_prompt, text)
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
        truncate_and_normalize(full, MODEL.dims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the model file: `REFLECT_EMBED_MODEL=/path/to/model.gguf
    /// GGML_METAL_NO_RESIDENCY=1 cargo test -p reflect-embed -- --ignored
    /// embeds_with_the_real_model`. On macOS the variable keeps ggml from
    /// aborting at exit, as in the app's `main`.
    #[test]
    #[ignore = "needs the model file"]
    fn embeds_with_the_real_model() {
        let path = std::env::var("REFLECT_EMBED_MODEL").expect("REFLECT_EMBED_MODEL");
        let mut model = Model::load(Path::new(&path)).unwrap();
        let first = model.embed_document("Notes about gardening").unwrap();
        let again = model.embed_document("Notes about gardening").unwrap();
        let query = model.embed_query("Notes about gardening").unwrap();
        assert_eq!(first.len(), MODEL.dims);
        let norm = first.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "norm {norm}");
        assert_eq!(first, again);
        assert_ne!(first, query);
        let long = model.embed_document(&"word ".repeat(5000)).unwrap();
        assert_eq!(long.len(), MODEL.dims);
    }
}
