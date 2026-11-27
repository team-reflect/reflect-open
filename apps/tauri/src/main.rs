// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ggml registers every Metal buffer in a residency set and asserts at exit
    // that none is left, but the embedding model lives for the whole process.
    // https://github.com/ggml-org/llama.cpp/blob/d81235049384534c167caea52b85a694f6103d14/ggml/src/ggml-metal/ggml-metal-device.m#L1039-L1040
    #[cfg(target_os = "macos")]
    // SAFETY: no other thread runs yet.
    unsafe {
        std::env::set_var("GGML_METAL_NO_RESIDENCY", "1");
    }
    reflect_open_lib::run()
}
