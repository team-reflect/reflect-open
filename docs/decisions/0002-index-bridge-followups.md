# 0002 — Index/IPC bridge follow-ups

- **Status:** Backlog (proposed improvements; not yet decided/scheduled)
- **Date:** 2026-06-12
- **Relates to:** [TDR 0001 — Raw SQL writes over the Rust IPC bridge](0001-raw-sql-writes-over-ipc.md)

This is a follow-up backlog that came out of the TDR 0001 investigation into the
SQLite write path. TDR 0001 recommended *keeping* the dedicated typed write
commands; while reading the surrounding code we found several improvements worth
making **independently** of that decision. They are listed highest-value first.
Each is sized and scoped so it can be picked up on its own.

| # | Item | Value | Effort | Status |
|---|------|-------|--------|--------|
| 1 | Tighten the webview CSP | High (security) | Medium | Proposed |
| 2 | Lock the read bridge to pure reads (deny ATTACH/DETACH/PRAGMA) | High (security) | Small | **✅ Done (this session)** |
| 3 | Generate write-payload types from one source | Medium (correctness/ergonomics) | Small–Medium | Proposed |
| 4 | Factor the gate+transaction command boilerplate | Low (cleanup) | Small | Proposed |
| 5 | Read/write concurrency (WAL reader split) | Deferred | Medium | Not yet |

---

## 1. Tighten the webview CSP — highest leverage

**Problem.** `apps/desktop/src-tauri/tauri.conf.json` sets `security.csp: null`.
The webview renders untrusted note markdown and untrusted LLM chat output, so a
renderer XSS (or a compromised renderer dependency) is a realistic threat — and
with no Content-Security-Policy there is nothing stopping injected script from
`fetch()`-ing out to an attacker host and exfiltrating note content. This is the
exact premise the whole security argument in TDR 0001 rests on, so it is worth
closing on its own merits regardless of the write-path decision.

**Why it's cheaper than it looks.** All real network egress is already brokered
through the **Rust** HTTP plugin, not webview `fetch`:

- AI/provider calls go through `providerFetch`
  ([`apps/desktop/src/lib/provider-fetch.ts`](../../apps/desktop/src/lib/provider-fetch.ts)),
  which is `@tauri-apps/plugin-http`'s `fetch`, wired into the AI SDK as
  `fetchFn` ([`apps/desktop/src/providers/chat-provider.tsx:307`](../../apps/desktop/src/providers/chat-provider.tsx)
  → `createOpenAI/Anthropic/GoogleGenerativeAI({ fetch })`, with OpenRouter using
  the OpenAI-compatible provider at a custom base URL, in
  [`packages/core/src/ai/chat/stream-chat.ts`](../../packages/core/src/ai/chat/stream-chat.ts)).
- GitHub calls use the same plugin.
- The allowed hosts are already enumerated in
  [`capabilities/default.json`](../../apps/desktop/src-tauri/capabilities/default.json)
  (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`,
  `openrouter.ai`, `github.com`, `api.github.com`).

Because the webview itself doesn't need to reach those hosts directly, its
`connect-src` can be **very tight**. A policy roughly like:

```
default-src 'self';
connect-src 'self' ipc: http://ipc.localhost;   # Tauri IPC only
img-src 'self' asset: http://asset.localhost data: blob:;  # note assets
style-src 'self' 'unsafe-inline';                # Tailwind/editor inline styles
script-src 'self';                               # no inline script
```

means even a full renderer XSS can't phone home directly — exfiltration would
have to go through the Rust plugin, which only permits the enumerated provider
hosts. That converts a "render-content → exfiltrate-anything" XSS into a much
weaker primitive.

**What to get right / risks.**
- The ProseKit/meowdown editor and Tailwind likely inject inline styles; a strict
  `script-src` may need nonces or hashes for any inline bootstrap. Expect some
  iteration to find a policy that doesn't break the editor or HMR.
- Tauri serves over a custom protocol; `connect-src` must allow the IPC origin
  (`ipc:`/`http://ipc.localhost`) and `img-src`/asset loading must allow the
  asset protocol used for note attachments. Verify against the actual protocols
  this build uses rather than copying the sketch above verbatim.
- Dev (Vite HMR with inline scripts/websocket) vs. production may warrant
  different policies — Tauri supports a dev-only CSP override.

**Recommendation.** Worth its own small spike + PR. Start with a strict
production CSP, iterate until the editor and asset rendering are happy, and keep
a looser dev CSP if HMR requires it. High security value, contained blast radius.

---

## 2. Lock the read bridge to pure reads — ✅ done this session

**Problem (confirmed).** The read-only `db_query` bridge gated writes only with
`rusqlite::Statement::readonly()`
([`apps/desktop/src-tauri/src/db/query.rs`](../../apps/desktop/src-tauri/src/db/query.rs)).
SQLite considers `ATTACH`/`DETACH` and connection-state `PRAGMA`s "read only"
even though none of them read our projection. A failing probe test confirmed the
hole: the bridge accepted

```sql
ATTACH DATABASE '/path/to/any.sqlite' AS evil
```

which a compromised renderer could follow with a `SELECT` to **read an arbitrary
SQLite file elsewhere on the user's disk** — a file-exfiltration primitive. A
`PRAGMA foreign_keys = OFF` was similarly accepted and would disable the
`ON DELETE CASCADE` relationships the write path's `apply_note`/`remove_note`
rely on.

**Fix (landed).** A scoped SQLite authorizer (`read_only_authorization` in
`query.rs`) denies `Attach`/`Detach`/`Pragma` at prepare time; everything a read
needs (`SELECT`, table/column reads, functions, FTS5/vec0 `MATCH`) is allowed.
It's installed around `prepare` and cleared immediately after, **scoped to the
read bridge** — the write path doesn't prepare through `run_query`, so its
legitimate `PRAGMA defer_foreign_keys` (used by `note_move_indexed`/`index_move`)
is unaffected. This required enabling rusqlite's `hooks` feature on the desktop
crate only (the CLI build graph doesn't pull it in).

**Verification.** Regression test `read_bridge_refuses_attach_and_pragma`
(asserts ATTACH + PRAGMA are refused and that a normal `SELECT`/FTS `MATCH` still
works); all 37 `db::tests` pass, including the `move_note` tests that exercise
the write path's PRAGMA; clippy clean.

**Residual / future.** The authorizer denies *all* pragmas through the read
bridge, which is correct today (reads never need one). If a future read path ever
needs a specific read-only pragma, prefer allow-listing that one pragma name over
loosening the deny.

---

## 3. Generate write-payload types from one source

**Problem.** The write commands carry payloads typed by **hand-mirrored** structs
on both sides: a Rust serde struct and a TS/zod shape that must be kept identical
by hand. The code says so explicitly:

> Mirrors the `indexedNoteSchema` zod contract … field-for-field … a change on
> either side must be mirrored on the other.
> — [`write.rs:14`](../../apps/desktop/src-tauri/src/db/write.rs)

The same mirror exists for `ChatConversation`/`ChatMessageRow`
([`chat_write.rs`](../../apps/desktop/src-tauri/src/db/chat_write.rs)) and
`EmbeddedChunk` ([`embed_write.rs`](../../apps/desktop/src-tauri/src/db/embed_write.rs)).
Drift is only caught at runtime (serde rejection + payload tests), never at
compile time. This is the legitimate ergonomic pain that motivated the
"generic `db_execute`" idea in TDR 0001 — but it can be fixed without opening a
raw-SQL write surface.

**Context.** The repo already has a codegen culture on the *read* side: the
Kysely `Database` type is generated from the migrations
(`packages/db/src/schema.gen.ts` via `db:codegen`), and CI fails on a diff so it
can't drift. Writes deserve the same discipline.

**Options.**
- **Surgical — `ts-rs`.** Derive TS interfaces for the payload structs
  (`IndexedNote` & friends, `ChatMessageRow`, `EmbeddedChunk`) directly from the
  Rust structs, emitted to a generated `.ts` the TS wrappers import. Smallest
  change; kills the specific skew on the big structs; keeps everything else as-is.
- **Full — `tauri-specta`.** Generate TS command bindings *and* payload types
  from the `#[tauri::command]` signatures, replacing most of the hand-written
  wrappers in `commands.ts`/`store.ts`/`embeddings/commands.ts` too. Bigger change
  to how commands are declared and how the bridge is wired; more upside, more
  blast radius.

Note that write payloads are app-constructed (not external input), so **types
suffice** — runtime zod validation is only genuinely needed on *responses* and
external data, and write responses are already just `z.null()`. So neither option
needs to add per-field runtime validation on the write path.

**Recommendation.** Start with `ts-rs` (surgical) to remove the documented skew
risk on the payload structs. Consider `tauri-specta` later only if the
command-binding boilerplate becomes a recurring tax — size it as its own
investigation.

---

## 4. Factor the gate + transaction command boilerplate

**Problem.** Several write commands in
[`db/mod.rs`](../../apps/desktop/src-tauri/src/db/mod.rs) repeat the same scaffold:
lock the state, `if state.generation != generation { return Ok(()) }`,
`conn.as_mut().ok_or_else(AppError::no_graph)?`, open a transaction, run row
logic, `commit`. `apply_in_txn`/`move_rows` already factor *part* of this, but
`index_meta_set`, `index_clear`, `chat_conversation_delete`, `chat_message_save`,
`embed_apply`, `embed_remove` each restate it.

**Proposal.** A single helper, e.g.

```rust
fn with_gated_txn<R>(
    index: &State<IndexState>,
    generation: u64,
    body: impl FnOnce(&rusqlite::Transaction) -> AppResult<R>,
) -> AppResult<Option<R>>  // None = stale generation, no-op
```

collapses each command to just its row logic and makes forgetting the generation
gate **structurally impossible**. Pure refactor — no behavior or security change,
and the existing `db::tests` already pin the behavior it must preserve (including
`stale_generation_writes_are_dropped_end_to_end`).

**Recommendation.** Low-risk cleanup; do it whenever this file is next touched.
Keep `note_move_indexed` (which interleaves a filesystem rename and its own
compensation, and gates on the *graph* generation rather than the index
generation) outside the helper — it doesn't fit the single-transaction shape and
its differences are deliberate.

---

## 5. Read/write concurrency (WAL reader split) — not yet

The index uses a single connection under one mutex, so a long read (FTS/vec scan)
and a write serialize against each other. This is already acknowledged in the
code as a deliberate first-wave tradeoff:

> The single connection also means reads (`db_query`) and writes (`index_*`) are
> serialized … Acceptable at first-wave scale; a read-pool / WAL reader split can
> come later. — [`db/mod.rs:44`](../../apps/desktop/src-tauri/src/db/mod.rs)

**Recommendation.** Leave as-is until there is evidence of real contention (e.g.
UI jank during large rebuilds on big graphs). The DB is already opened in WAL
mode, so a separate read-only connection pool is the natural lever when the time
comes — but it adds connection-lifecycle complexity (and the generation/rebind
dance currently relies on there being exactly one connection), so it shouldn't be
done speculatively.

---

## Suggested sequencing

1. **#2** — done.
2. **#1 (CSP)** — highest remaining value; hardens the boundary the whole write-path
   analysis assumes. Own spike/PR.
3. **#3 (`ts-rs`)** — removes the documented payload skew risk; small.
4. **#4 (boilerplate helper)** — opportunistic cleanup.
5. **#5** — only when contention is measured.
