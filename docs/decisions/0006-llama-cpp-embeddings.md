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
  model; `candle`; a multilingual MiniLM; EmbeddingGemma 2 (see
  [Why not EmbeddingGemma 2](#why-not-embeddinggemma-2)).

---

## TL;DR

**Embeddings run on llama.cpp (`llama-cpp-2`) with EmbeddingGemma 300M Q8_0,
truncated to 256 dimensions.** llama.cpp compiles from source with CMake on
every target, so there is no prebuilt dylib to download, sign or match against
glibc. EmbeddingGemma is multilingual. The index migrates to a 256-dimension
vector table and re-embeds every note once.

## The decision

### Runtime

- `llama-cpp-2` without default features (no OpenMP, no `common` library).
  ggml builds Metal for every Apple target. Apple Silicon Macs and iOS run on
  Metal; Windows and Linux run on the CPU.
- iOS does not let a background app use the GPU. While the app is hidden,
  `SemanticSearchService` stops embedding and calls `embed_unload`, which
  drops the context. It loads the model again when the app is visible.
- The model download waits on an expensive connection (cellular, a personal
  hotspot, or Low Data Mode) until the connection is free or the user allows
  it. `embed_model_downloaded` tells whether the file is on disk, and the iOS
  shell reports the connection cost through `plugin:network`.
- The iOS app links Accelerate, Metal and Foundation itself
  (`apps/ios/Config/App.xcconfig`), because the Rust core is a static library.
  The models directory is excluded from iCloud backups.
- Intel Macs keep the stand-in runtime until the llama.cpp runtime is tested
  on them. Their build includes Metal too, so a CPU-only run would need
  `with_n_gpu_layers(0)` and `with_op_offload(false)`.
- One context, two threads, and the model's full 2048-token window. A longer
  text is truncated and keeps its closing EOS token. Chinese text takes about
  one token per two characters, so a 512-token window would cut the chunker's
  larger chunks.
- llama.cpp warnings and errors go to the app log. Other levels are dropped.
- The macOS app sets `GGML_METAL_NO_RESIDENCY` before any thread starts. The
  model lives until the process exits, and ggml aborts at exit while a Metal
  buffer is still in a residency set. The iOS app does the same at launch.
- `llama-cpp-sys-2` turns on ggml CPU features only from the Rust target
  features, which leaves x86_64 on SSE. `.cargo/config.toml` sets
  `GGML_AVX2`, `GGML_FMA` and `GGML_F16C`, which affect only ggml. AVX2
  implies AVX.
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
  commands: `embed_query` and `embed_note_chunks`. `embed_note_chunks`
  writes a note's chunk set to the index, so vectors do not pass through JS.
  A chunk whose hash is stored under the same model keeps its vector; the
  runtime embeds the rest. An empty set drops the note's chunks.
- The output is truncated to 256 dimensions (Matryoshka) and normalized.
- After a load, the runtime deletes every other file in its models directory:
  the old MiniLM cache and the files of older model revisions.

### Why not EmbeddingGemma 2

Google released [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)
in September 2026. It is Apache 2.0, and its text model has 270M parameters. We
keep EmbeddingGemma (the first version) because EmbeddingGemma 2 retrieves
English text less well, in Google's results and in ours, and it is slower.

**Google's results.** The
[EmbeddingGemma 2 technical report](https://arxiv.org/html/2610.37364)
(arXiv 2610.37364) says: "On English, the model sees a modest regression."
Its gains are on multilingual bitext mining and classification, code and other
media, not on text retrieval:

| Source in the report | EmbeddingGemma | EmbeddingGemma 2 |
|---|---|---|
| Table 1, MTEB(Eng, v2) Mean (Task) | 69.67 | 68.46 |
| Table 14, MTEB(Eng, v2) Retrieval, 768 dimensions | 55.7 | 51.7 |
| Table 14, MTEB(Eng, v2) Retrieval, 256 dimensions | not reported | 49.4 |

Google's [MTEB result files](https://github.com/embeddings-benchmark/results)
show the same drop on single tasks, for example
ArguAna (0.715 to 0.598) and FiQA2018 (0.477 to 0.323), nDCG@10.

**Our results.** Both models ran through llama.cpp as Q8_0 GGUF, with the
app's prompts, mean pooling and 256 dimensions. Scores are nDCG@10:

| Dataset | Queries | Documents | EmbeddingGemma | EmbeddingGemma 2 |
|---|---|---|---|---|
| SciFact | 300 | 5,183 | 0.782 | 0.839 |
| NFCorpus | 323 | 3,633 | 0.367 | 0.349 |
| ArguAna | 1,401 | 8,674 | 0.667 | 0.574 |
| FiQA2018 (sampled corpus) | 648 | 15,000 | 0.567 | 0.412 |
| Quora (sampled corpus) | 800 | 10,000 | 0.990 | 0.990 |

- Where the full test set was used, our scores are within about 0.01 of the
  published MTEB scores once the task prompt matches, so the harness is sound.
- llama.cpp's EmbeddingGemma 2 vectors match the reference
  sentence-transformers output (cosine similarity 1.0), so the gap comes from
  the model, not from the runtime.
- EmbeddingGemma 2 takes 20 to 45 percent longer per text on Metal, and about
  3.6 times longer on the CPU with two threads.
- `llama-cpp-2` 0.1.161 cannot load it: llama.cpp added the
  `gemma-embedding2` architecture after the revision that the crate vendors.

Look again when a newer EmbeddingGemma scores higher on English retrieval.

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
- The same runtime runs on iOS. The mobile settings have the opt-in.
- An older app that opens a migrated index embeds every note on each backfill
  and fails each write. It keeps working, but spends CPU until it is updated.
