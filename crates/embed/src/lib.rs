//! The llama.cpp embedding backend. It lives outside `reflect-core`, so the
//! core compiles while llama.cpp's CMake build runs.

use std::sync::Arc;

use reflect_types::EmbedBackend;

#[cfg(not(any(
    target_os = "android",
    all(target_os = "macos", target_arch = "x86_64")
)))]
mod llama;

/// The embedding backend for this platform and CPU, or `None` when it has
/// none. Intel macOS is not tested with llama.cpp yet.
pub fn backend() -> Option<Arc<dyn EmbedBackend>> {
    #[cfg(not(any(
        target_os = "android",
        all(target_os = "macos", target_arch = "x86_64")
    )))]
    if cpu_supported() {
        return Some(Arc::new(llama::Llama));
    }
    None
}

/// ggml's x86_64 kernels are built for AVX2, FMA and F16C (`.cargo/config.toml`).
/// Without them the first embed dies with SIGILL, which no error path can
/// catch, so check before loading and report `unsupported` instead.
#[cfg(all(
    target_arch = "x86_64",
    not(any(target_os = "android", target_os = "macos"))
))]
fn cpu_supported() -> bool {
    std::is_x86_feature_detected!("avx2")
        && std::is_x86_feature_detected!("fma")
        && std::is_x86_feature_detected!("f16c")
}

#[cfg(not(any(target_arch = "x86_64", target_os = "android")))]
fn cpu_supported() -> bool {
    true
}
