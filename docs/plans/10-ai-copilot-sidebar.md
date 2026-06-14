# Plan 10 — AI Copilot Sidebar

**Goal:** The AI-native heart: one right-sidebar copilot with BYOK providers, visible
local context, chat/summarize/rewrite, and reviewable multi-note patchsets — with
`private: true` as a hard cloud block. This is **M3.**

> **Revision (2026-06-11) — dedicated Chat view, read-only first wave.** The copilot
> shipped as a **dedicated full-screen view** (`chat` route, a "Chat" sidebar button under
> "New note", `⌘J`) rather than the right-sidebar panel: a conversation deserves the whole
> column, and the right slot stays free for note context (Plan 07). The first wave is
> **read-only** — no patchsets, rewrite, or any write path yet (steps 5–6 below are
> deferred). The model is grounded through two tools instead of pre-assembled context:
> `search_notes` (the shared `retrieve()`, `excludePrivateContent: true`, private hits
> dropped entirely) and `read_note` (live frontmatter re-check before any content leaves;
> private notes get a structured refusal). Step 4's structural gate shipped as a branded
> `CloudSafe<T>` type: tool outputs carry note content only as `CloudSafe` values, and the
> sole constructors (`cloudSafeSearchHits`, `cloudSafeNoteContent` in `ai/checkers.ts`)
> run the privacy checks — an unchecked payload doesn't typecheck. Tool activity
> renders inline in the transcript — the transparent-context requirement, in tool form.
> Engine: Vercel AI SDK v6 in `@reflect/core` (`ai/chat/`), streaming normalized to a
> typed event union; answers cite notes as `[[wiki links]]` that navigate (and never
> create) notes. Keychain secrets, BYOK settings UI, and provider key validation
> (steps 1–2) had already landed.

**Depends on:** Plan 05 (apply edits), Plan 07 (backlink context), Plan 09 (`retrieve()`),
keychain (introduced here, reused by Plan 12).
**Unlocks:** AI-assisted conflict resolution (Plan 12), future agentic workflows.

**Architecture:** provider/AI calls, context assembly, and patchset policy live in
`@reflect/core` (`actions/ai`); the `private: true` block is a `checkers.ts` guard
(`assertCloudAllowed`); keychain is a Rust primitive. See
[Architecture & Conventions](architecture-conventions.md).

**Libraries:** Vercel AI SDK (`ai` + `@ai-sdk/openai`/`@ai-sdk/anthropic`/
`@ai-sdk/google`), `keyring` (Rust, BYOK keys). `diff`/jsdiff is not installed because
patchsets are deferred. See [Libraries](libraries.md).

## Scope

**In:** provider config (BYOK, multi-provider), keychain secrets, context assembly from
local retrieval, read-only chat over notes, transparent tool activity, durable chat
history, and privacy enforcement. The original summarize/rewrite/patchset scope is still
recorded below as the next wave.
**Out:** local generative models (later), background auto-extraction beyond opt-in
reviewable suggestions, agentic multi-step tools (later), audio memos (shipped
separately through `actions/audio-memo`).

## Steps

1. **Secrets via OS keychain.** A Rust keychain module (e.g. `keyring` crate → macOS
   Keychain) with `secret_set/get/delete`. BYOK keys **never** touch markdown, Git, or
   `.reflect/`. Settings UI (react-hook-form) to enter/validate an OpenAI key; provider
   abstraction leaves room for Anthropic/Google later.

2. **Provider layer.** A typed provider interface — `chat(messages, opts)` (streaming)
   and a model picker. **Calls go directly app → provider** using the user's key; no
   Reflect-hosted proxy. Normalize streaming + errors (rate limit, auth) into typed
   results. zod-validate responses.

   ```ts
   export interface AiProvider {
     id: 'openai' | 'anthropic' | 'google'
     chat(req: ChatRequest): AsyncIterable<ChatDelta>
   }
   ```

3. **Context assembly (transparent).** Build prompt context from: current note, current
   selection, incoming/outgoing backlinks (Plan 07), and `retrieve()` hits (Plan 09,
   `excludePrivateContent: true`). The sidebar **shows what context it's using** (current
   + retrieved chips); the user can add/remove context. If anything is sent externally,
   that is visible.

4. **Privacy hard-block (`private: true`) — structural, not "remember to check".** A
   "call the checker at every call site" pattern is fragile. Instead make it a **type-level
   choke-point**: the provider client accepts only a `CloudContext` value, and the *only*
   constructor for `CloudContext` runs `assertCloudAllowed` over every item and drops/blocks
   private content — so an unchecked payload can't be built. Reinforced by retrieval
   filtering (Plan 09, `excludePrivateContent: true`). Two correctness details review
   surfaced:
   - **Read `private` from the live note at call time**, not just the index — the index can
     be stale (TOCTOU) right after a user adds `private: true`. Re-check frontmatter on the
     current/selected note before sending.
   - **Per-note granularity is the documented limit:** the flag protects a note's *own*
     body. Content from a private note that's been pasted/quoted into a non-private note is
     **not** detected first wave. State this honestly in the privacy UX; revisit later.
   Tests: a private note's body never appears in an outbound request (payload assertion);
   constructing a `CloudContext` from private content throws.

5. **Core capabilities (first wave).** Chat about the current note; summarize the note;
   rewrite selected text; answer questions using local notes (grounded, with cited note
   links); suggest related notes/backlinks; extract action items as text. Grounding +
   citations mirror V1's deliberately-grounded chat (not a free-floating chatbot).

6. **Patchset edit model.** AI edits are **patchsets**, not silent writes:
   - represent edits as a structured diff over one or more notes;
   - render a reviewable diff UI (per-note, per-hunk accept/reject);
   - **always create a local checkpoint before applying** (the recovery primitive shared
     with Plan 12);
   - risky/broad/destructive edits **require review**; only low-risk patches may
     auto-apply, and only after checkpoint + with locked notes excluded.
   Apply path: for *closed* notes, use Plan 03 splice/minimal-diff file edits; for the
   *open* note, apply into the meowdown instance (`editor.setContent(markdownToDoc(...))`
   or a PM transaction) so the buffer and file stay consistent. Then reindex (Plan 04).
   Diff/patch generation works on markdown text (engine-agnostic), avoiding coupling to
   meowdown's `docToMarkdown` normalization.

   ```ts
   export interface NotePatch { noteId: string; before: string; after: string }
   export interface PatchSet {
     id: string
     patches: NotePatch[]
     rationale: string
     risk: 'low' | 'medium' | 'high'
     requiresReview: boolean
   }
   ```

7. **Sidebar UX.** Right-sidebar panel (the app-shell slot from Plan 01), keyboard-native:
   invoke sidebar, move focus editor↔sidebar, accept/reject/apply edits — all in the
   central keymap (Plan 05). Streaming responses; cancellable; conversation scoped to the
   current note by default.

8. **Tests.** Private-note exclusion (outbound payload assertion); patchset apply +
   checkpoint; review-required gating for high-risk patches; context assembly includes
   backlinks + retrieval and excludes private content; provider error handling.

## Key decisions / contracts

- **BYOK, direct-to-provider, OpenAI-first**; no hosted AI. Keys in OS keychain only.
- **`private: true` is enforced at two structural points** (retrieval filtering + the
  `CloudContext` construction gate), not an ad-hoc call-site check.
- **All AI edits are reviewable patchsets, checkpointed before apply**; high-risk
  requires review.
- **Context is visible**; grounded answers cite local notes.
- **One retrieval layer** (Plan 09) feeds AI — no separate AI index.

## Acceptance criteria

- User adds an OpenAI key (stored in Keychain); chat about the current note streams back.
- Sidebar shows current + retrieved context chips; user can edit the context set.
- Opening a `private: true` note blocks cloud calls with a clear message; its content
  never appears in an outbound request (test-asserted).
- "Rewrite selection" / multi-note edits produce a reviewable diff; applying first writes
  a checkpoint, then minimal-diff edits, then reindexes.
- `pnpm typecheck` + tests pass.

## Risks

- **Accidental private leakage** — highest-severity risk. Mitigate with double
  enforcement + an explicit outbound-payload test + a redaction assertion in the provider
  client.
- **Patch application corrupting notes.** Mitigate: AST/minimal-diff edits, mandatory
  pre-apply checkpoint, review gating, round-trip tests (Plan 03).
- **Provider/streaming variance + cost surprises.** Normalize errors; show model/usage;
  let the user pick models.
