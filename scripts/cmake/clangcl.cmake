# ggml on Windows ARM64 needs clang: MSVC builds its ARM code only with GGML_NATIVE.
set(CMAKE_GENERATOR_TOOLSET ClangCL)
