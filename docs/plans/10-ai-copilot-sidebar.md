# Plan 10 — AI Copilot Sidebar

**Goal:** The AI-native heart: one copilot with BYOK providers, visible local context,
chat/summarize/rewrite, and reviewable multi-note patchsets, with `private: true` as a
hard cloud block. This is **M3.**

> **Revision (2026-06-11): dedicated Chat view, read-only first wave.** The copilot
> shipped as a **full-screen view** (`chat` route, a "Chat" sidebar button under "New
> note", `⌘J`), not the right-sidebar panel: a conversation deserves the whole column,
> and the right slot stays free for note context (Plan 07). The first wave is
> **read-only**: no patchsets, rewrite, or write path (steps 5–6 deferred). The model is
> grounded through two tools instead of pre-assembled context: `search_notes` (shared
> `retrieve()`, `excludePrivateContent: true`, private hits dropped entirely) and
> `read_note` (live frontmatter re-check before content leaves; private notes get a
> structured refusal). Step 4's gate shipped as a branded `CloudSafe<T>` type whose only
> constructors (in `ai/checkers.ts`) run the privacy checks, so an unchecked payload
> does not typecheck. Tool activity renders inline in the transcript: the
> transparent-context requirement, in tool form. Engine: Vercel AI SDK v6 in
> `@reflect/core`; answers cite notes as `[[wiki links]]` that navigate to (never
> create) notes. Keychain secrets, BYOK settings, and key validation (steps 1–2) had
> already landed.

**Depends on:** Plan 05 (apply edits), Plan 07 (backlink context), Plan 09 (`retrieve()`),
keychain (introduced here, reused by Plan 12).
**Unlocks:** AI-assisted conflict resolution (Plan 12), future agentic workflows.

**Architecture:** provider calls, context assembly, and patchset policy live in
`@reflect/core`; the `private: true` block is a `checkers.ts` guard; keychain is a Rust
primitive. See [Architecture & Conventions](architecture-conventions.md).

**Libraries:** Vercel AI SDK, `keyring` (Rust). `diff`/jsdiff is not installed because
patchsets are deferred. See [Libraries](libraries.md).

## Scope

**In:** BYOK multi-provider config, keychain secrets, context from local retrieval,
read-only chat over notes, transparent tool activity, durable chat history, privacy
enforcement. Summarize/rewrite/patchsets stay recorded below as the next wave.
**Out:** local generative models, background auto-extraction beyond opt-in reviewable
suggestions, agentic multi-step tools, audio memos (shipped separately).

## Steps

1. **Secrets via OS keychain.** BYOK keys **never** touch Markdown, Git, or `.reflect/`.
   Settings UI to enter/validate a key; OpenAI first, room for Anthropic/Google.
2. **Provider layer.** **Calls go directly app → provider** with the user's key; no
   Reflect-hosted proxy. Streaming and errors (rate limit, auth) normalize into typed
   results.
3. **Context assembly (transparent).** Context comes from the current note, selection,
   backlinks (Plan 07), and `retrieve()` hits (`excludePrivateContent: true`). The UI
   **shows what context it uses** and lets the user edit it; anything sent externally is
   visible.
4. **Privacy hard-block, structural, not "remember to check".** Calling a checker at
   every call site is fragile. Instead the provider client accepts only a checked
   context value whose sole constructor drops/blocks private content, so an unchecked
   payload cannot be built. Retrieval filtering (Plan 09) reinforces it. Two details
   from review:
   - **Read `private` from the live note at call time**, not only the index, which can
     be stale (TOCTOU) right after a user adds `private: true`.
   - **Per-note granularity is the documented limit:** the flag protects a note's own
     body. Private content pasted into a non-private note is **not** detected first
     wave. Say so in the privacy UX.
   Tests assert a private body never appears in an outbound payload, and that building
   a checked context from private content throws.
5. **Core capabilities (next wave).** Chat about the note, summarize, rewrite selection,
   grounded answers with cited note links, suggest related notes, extract action items.
   Grounding mirrors V1's deliberately grounded chat, not a free-floating chatbot.
6. **Patchset edit model (next wave).** AI edits are **patchsets** (per-note before/after,
   rationale, risk level), never silent writes:
   - reviewable per-note, per-hunk accept/reject diff UI;
   - **always a local checkpoint before applying** (the recovery primitive shared with
     Plan 12);
   - risky/broad/destructive edits **require review**; only low-risk patches may
     auto-apply, after checkpoint, with locked notes excluded.
   Closed notes get Plan 03 minimal-diff file edits; the open note is updated through the
   editor instance so buffer and file stay consistent; then reindex. Diffs work on
   Markdown text, so they do not couple to meowdown's `docToMarkdown` normalization.
7. **UX.** Keyboard-native (invoke, move focus editor↔copilot, accept/reject) through the
   central keymap (Plan 05). Streaming and cancellable.
8. **Tests:** private exclusion (payload assertion), patchset apply + checkpoint,
   review gating, context assembly, provider errors.

## Key decisions / contracts

- **BYOK, direct-to-provider, OpenAI-first**; no hosted AI. Keys in OS keychain only.
- **`private: true` is enforced at two structural points** (retrieval filtering + the
  checked-context construction gate), not ad-hoc call-site checks.
- **All AI edits are reviewable patchsets, checkpointed before apply**; high-risk
  requires review.
- **Context is visible**; grounded answers cite local notes.
- **One retrieval layer** (Plan 09) feeds AI; no separate AI index.

## Acceptance criteria

- User adds an OpenAI key (stored in Keychain); chat about notes streams back.
- Context in use is visible and editable.
- A `private: true` note's content never appears in an outbound request (test-asserted).
- Rewrite/multi-note edits produce a reviewable diff; apply writes a checkpoint, then
  minimal-diff edits, then reindexes.

## Risks

- **Accidental private leakage** (highest severity): double enforcement, an outbound
  payload test, and a redaction assertion in the provider client.
- **Patch application corrupting notes:** minimal-diff edits, mandatory checkpoint,
  review gating, round-trip tests (Plan 03).
- **Provider variance and cost surprises:** normalize errors, show model/usage, let the
  user pick models.
