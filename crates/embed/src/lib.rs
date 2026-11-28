//! The local embedding model (Plan 09): EmbeddingGemma, downloaded on demand
//! into app data and never bundled, run in-process with llama.cpp. See
//! `docs/decisions/0006-llama-cpp-embeddings.md`.

mod download;

use std::path::{Path, PathBuf};

#[cfg(not(any(
    target_os = "android",
    all(target_os = "macos", target_arch = "x86_64")
)))]
mod llama;
#[cfg(not(any(
    target_os = "android",
    all(target_os = "macos", target_arch = "x86_64")
)))]
pub use llama::Model;

// Intel macOS has the stand-in too: the llama.cpp runtime is not tested on
// Intel Macs yet.
#[cfg(any(
    target_os = "android",
    all(target_os = "macos", target_arch = "x86_64")
))]
mod unsupported;
#[cfg(any(
    target_os = "android",
    all(target_os = "macos", target_arch = "x86_64")
))]
pub use unsupported::Model;

/// What to download and how to run it. The stand-in runs nothing, so it reads
/// only the download fields.
#[cfg_attr(
    any(
        target_os = "android",
        all(target_os = "macos", target_arch = "x86_64")
    ),
    allow(dead_code)
)]
struct ModelSpec {
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
    dims: 256,
    max_tokens: 2048,
    query_prompt: "task: search result | query: ",
    document_prompt: "title: none | text: ",
};

/// The model id recorded on every embedded chunk. A new id re-embeds every
/// note.
pub const MODEL_ID: &str = MODEL.id;

/// The size of the model file in bytes.
pub const MODEL_SIZE: u64 = MODEL.size;

/// The length of every vector the model returns.
pub const DIMS: usize = MODEL.dims;

/// Whether this platform and CPU can run the model.
pub fn supported() -> bool {
    cfg!(not(any(
        target_os = "android",
        all(target_os = "macos", target_arch = "x86_64")
    ))) && cpu_supported()
}

/// ggml's x86_64 kernels are built for AVX2, FMA and F16C (`.cargo/config.toml`).
/// Without them the first embed dies with SIGILL, which no error path can
/// catch, so check before loading.
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

/// Whether `models_dir` holds the whole model. A file of another size is
/// damaged.
pub async fn model_downloaded(models_dir: &Path) -> bool {
    tokio::fs::metadata(model_path(models_dir))
        .await
        .is_ok_and(|meta| meta.len() == MODEL.size)
}

/// The model file in `models_dir`, downloaded first unless it is there.
/// `progress` gets the bytes on disk during a download.
pub async fn download_model(
    models_dir: &Path,
    progress: impl FnMut(u64),
) -> Result<PathBuf, String> {
    let path = model_path(models_dir);
    if model_downloaded(models_dir).await {
        return Ok(path);
    }
    let url = model_url();
    download::fetch(
        &download::Download {
            url: &url,
            size: MODEL.size,
            sha256: MODEL.sha256,
        },
        &path,
        progress,
    )
    .await?;
    Ok(path)
}

/// Delete everything in `models_dir` except `keep`: the caches of the replaced
/// ONNX runtime and the files of older model specs. The directory belongs to
/// the embedding runtime. Failures only cost disk space.
pub fn remove_other_models(models_dir: &Path, keep: &Path) {
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

/// The leading `dims` of `full` (Matryoshka truncation), scaled to a unit
/// vector.
#[cfg_attr(
    any(
        target_os = "android",
        all(target_os = "macos", target_arch = "x86_64")
    ),
    allow(dead_code)
)]
fn truncate_and_normalize(full: &[f32], dims: usize) -> Result<Vec<f32>, String> {
    let mut vector = full
        .get(..dims)
        .ok_or_else(|| format!("the model returned {} dimensions", full.len()))?
        .to_vec();
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        vector.iter_mut().for_each(|value| *value /= norm);
    }
    Ok(vector)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_leading_dimensions_as_a_unit_vector() {
        assert_eq!(
            truncate_and_normalize(&[3.0, 4.0, 9.0], 2).unwrap(),
            [0.6, 0.8]
        );
        assert!(truncate_and_normalize(&[1.0], 2).is_err());
    }
}
