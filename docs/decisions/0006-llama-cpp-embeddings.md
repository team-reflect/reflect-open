# TDR 0006 — Local embeddings: llama.cpp with EmbeddingGemma

- **Status:** Accepted
- **Date:** 2026-11-27
- **Scope:** The semantic-search embedding runtime in `reflect-core`
  (`crates/core/src/embed/`) and the vector table in the index. It replaces the
  `fastembed` and all-MiniLM-L6-v2 runtime from [Plan 09](../plans/09-semantic-search-and-embeddings.md).
  Chunking, retrieval and the `embed_*` status flow do not change.
- **Decision driver:** One runtime that builds for every desktop target and for
  iOS, with a model that understands languages other than English.
- **Alternatives evaluated:** keep `fastembed` (ONNX Runtime) and change only the
  model; `candle`; a multilingual MiniLM.

---

## TL;DR

**Embeddings run on llama.cpp (`llama-cpp-2`) with EmbeddingGemma 300M Q8_0,
truncated to 256 dimensions.** llama.cpp compiles from source with CMake on
every target, so there is no prebuilt dylib to download, sign or match against
glibc. EmbeddingGemma is multilingual. The index migrates to a 256-dimension
vector table and re-embeds every note once.

## The decision

### Runtime

- `llama-cpp-2` without default features (no OpenMP, no `common` library). The
  `metal` feature is on for Apple Silicon Macs; other desktops use the CPU.
- One context, two threads, and the model's full 2048-token window. A longer
  text is truncated and keeps its closing EOS token. Chinese text takes about
  one token per two characters, so a 512-token window would cut the chunker's
  larger chunks.
- llama.cpp warnings and errors go to the app log. Other levels are dropped.
- `llama-cpp-sys-2` turns on ggml CPU features only from the Rust target
  features, which leaves x86_64 on SSE. `.cargo/config.toml` sets
  `GGML_AVX2`, `GGML_FMA`, `GGML_F16C` and `GGML_AVX`, which affect only ggml.
  `cpu_supported()` reports `unsupported` on a CPU without them.
- Windows ARM64 builds llama.cpp with the ClangCL toolset
  (`scripts/cmake/clangcl.cmake`), because MSVC on ARM needs `GGML_NATIVE`.

### Model

- `ggml-org/embeddinggemma-300M-GGUF`, `Q8_0`, pinned to one revision, size and
  SHA-256 (`MODEL` in `crates/core/src/embed/mod.rs`). The model id is
  `embeddinggemma-300m-q8_0-d256`.
- The download resumes a partial file with an HTTP `Range` request and checks
  the SHA-256 before the file gets its final name. `HF_ENDPOINT` replaces the
  Hugging Face host.
- Queries and documents use the model's own prompts, so the runtime has two
  commands: `embed_query` and `embed_documents`.
- The output is truncated to 256 dimensions (Matryoshka) and normalized.
- After the first load, the runtime deletes the old MiniLM cache.

### Index

- Migration 0025 deletes every chunk and recreates `embedding_vectors` as
  `float[256]`. The model id change makes the embedding pass re-embed all notes.
- `MIN_COMPATIBLE_SCHEMA_VERSION` stays 23. An older app that opens the
  migrated index fails to write 384-dimension vectors inside a transaction it
  already tolerates, so lexical search, backlinks and tasks keep working there.
- `MAX_COSINE_DISTANCE` is 0.6. On an English and Chinese test corpus, the
  correct chunk's distance had a p90 of 0.53 and a maximum of 0.60; unrelated
  queries had a minimum of 0.56 and a median of 0.74.

### Licensing

- EmbeddingGemma is under the Gemma Terms of Use. The licenses screen shows the
  terms, the Prohibited Use Policy and the required notice
  (`apps/web/scripts/licenses/embeddinggemma.txt`). The user agreement must
  also carry the use restrictions of section 3.2.
- llama.cpp is MIT. Its license text is in
  `apps/web/scripts/licenses/llama.cpp.txt`, because cargo-about reports only
  the crate's own license.

## Consequences

- The model download grows from about 90 MB to about 330 MB.
- No ONNX Runtime: CI drops its cache steps, and Linux no longer needs the
  glibc of the prebuilt binary.
- CI runs build scripts without the mbx replay
  (`MBX_BUILD_SCRIPT_EXECUTION=0`), because the CMake build directory in
  OUT_DIR holds absolute paths. Each job compiles llama.cpp again.
- Intel Macs get semantic search too, on the CPU.
- The same runtime builds for iOS. Turning semantic search on there is a
  separate change.
- An older app that opens a migrated index embeds every note on each backfill
  and fails each write. It keeps working, but spends CPU until it is updated.
