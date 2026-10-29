# 0002 — Index/IPC bridge follow-ups

- **Status:** Backlog (proposed improvements; not yet decided/scheduled)
- **Date:** 2026-06-12
- **Relates to:** [TDR 0001 — Raw SQL writes over the Rust IPC bridge](0001-raw-sql-writes-over-ipc.md)

TDR 0001 recommended keeping the typed write commands. Reading the surrounding
code surfaced improvements worth making independently of that decision. Each
can be picked up on its own; highest value first.

| # | Item | Value | Effort | Status |
|---|------|-------|--------|--------|
| 1 | Tighten the webview CSP | High (security) | Medium | Proposed |
| 2 | Lock the read bridge to pure reads (deny ATTACH/DETACH/PRAGMA) | High (security) | Small | **✅ Done (this session)** |
| 3 | Generate write-payload types from one source | Medium (correctness/ergonomics) | Small–Medium | Proposed |
| 4 | Factor the gate+transaction command boilerplate | Low (cleanup) | Small | Proposed |
| 5 | Read/write concurrency (WAL reader split) | Deferred | Medium | Not yet |

---

## 1. Tighten the webview CSP — highest leverage

**Problem.** `tauri.conf.json` sets `security.csp: null`. The webview renders
untrusted markdown and LLM output, so a renderer XSS is realistic, and with no
CSP injected script can `fetch()` note content to an attacker host. TDR 0001's
security argument rests on this, so it is worth closing on its own.

**Why it's cheaper than it looks.** All real egress already goes through the
**Rust** HTTP plugin, not webview `fetch`: AI calls use
`@tauri-apps/plugin-http`'s `fetch` (today the `HttpService` adapter in
[`apps/desktop/src/services/tauri-http.ts`](../../apps/desktop/src/services/tauri-http.ts)),
passed to the AI SDK providers in
[`packages/core/src/ai/chat/chat-engine-service.ts`](../../packages/core/src/ai/chat/chat-engine-service.ts);
GitHub uses the same plugin; and the allowed hosts are enumerated in
[`capabilities/default.json`](../../apps/desktop/src-tauri/capabilities/default.json).
So the webview's `connect-src` can be very tight, roughly:

```
default-src 'self';
connect-src 'self' ipc: http://ipc.localhost;   # Tauri IPC only
img-src 'self' asset: http://asset.localhost data: blob:;  # note assets
style-src 'self' 'unsafe-inline';                # Tailwind/editor inline styles
script-src 'self';                               # no inline script
```

Then even a full renderer XSS cannot phone home directly; exfiltration must go
through the Rust plugin, which permits only the enumerated hosts.

**Risks.**
- The editor and Tailwind likely inject inline styles; a strict `script-src`
  may need nonces or hashes for inline bootstrap. Expect iteration.
- `connect-src` must allow the IPC origin, and `img-src` the asset protocol for
  attachments. Verify against the protocols this build uses; do not copy the
  sketch verbatim.
- Vite HMR may need a looser dev-only CSP (Tauri supports an override).

**Recommendation.** Own spike + PR: strict production CSP, iterate until the
editor and assets work, looser dev CSP if HMR needs it.

---

## 2. Lock the read bridge to pure reads — ✅ done this session

**Problem (confirmed).** `db_query` gated writes only with
`rusqlite::Statement::readonly()`
([`crates/index/src/query.rs`](../../crates/index/src/query.rs)). SQLite treats
`ATTACH`/`DETACH` and connection-state `PRAGMA`s as read-only. A probe test
confirmed the bridge accepted `ATTACH DATABASE '/path/to/any.sqlite' AS evil`,
which a compromised renderer could follow with a `SELECT` to read any SQLite
file on disk. `PRAGMA foreign_keys = OFF` was also accepted and would disable
the `ON DELETE CASCADE` that `apply_note`/`remove_note` rely on.

**Fix (landed).** A SQLite authorizer (`read_only_authorization` in `query.rs`)
denies `Attach`/`Detach`/`Pragma` at prepare time and allows everything a read
needs (`SELECT`, functions, FTS5/vec0 `MATCH`). It is installed around
`prepare` and cleared right after, scoped to the read bridge, so the write
path's `PRAGMA defer_foreign_keys` (`note_move_indexed`/`index_move`) is
unaffected. It needs rusqlite's `hooks` feature, on the desktop crate only.

**Verification.** Regression test `read_bridge_refuses_attach_and_pragma`
(ATTACH and PRAGMA refused, normal `SELECT`/FTS `MATCH` still works); all 37
`db::tests` passed, including the `move_note` tests that use the PRAGMA.

**Future.** If a read ever needs a specific read-only pragma, allow-list that
name rather than loosening the deny.

---

## 3. Generate write-payload types from one source

**Problem.** Write payloads are hand-mirrored: a Rust serde struct and a zod
shape kept identical by hand (`write.rs` says so for `IndexedNote`; the same
holds for `ChatConversation`/`ChatMessageRow` in `chat_write.rs` and
`EmbeddedChunk` in `embed_write.rs`, all now in
[`crates/index/src/`](../../crates/index/src/)). Drift is caught only at
runtime. This pain motivated the `db_execute` idea, but it can be fixed without
a raw-SQL surface.

**Context.** The read side is already codegen'd: the Kysely `Database` type
comes from the migrations (`packages/db/src/schema.gen.ts` via `db:codegen`),
and CI fails on a diff.

**Options.**
- **Surgical — `ts-rs`.** Derive TS interfaces for the payload structs from
  Rust into a generated `.ts` the wrappers import. Smallest change; removes the
  skew on the big structs.
- **Full — `tauri-specta`.** Generate command bindings and payload types from
  the `#[tauri::command]` signatures, replacing most hand-written wrappers.
  More upside, more blast radius.

Write payloads are app-constructed, so **types suffice**: runtime zod is needed
only on responses and external data, and write responses are `z.null()`.

**Recommendation.** Start with `ts-rs`. Consider `tauri-specta` only if
command-binding boilerplate becomes a recurring tax, as its own investigation.

---

## 4. Factor the gate + transaction command boilerplate

**Problem.** Several write commands in
[`db/mod.rs`](../../apps/desktop/src-tauri/src/db/mod.rs) repeat: lock, check
the generation, `conn.as_mut().ok_or_else(AppError::no_graph)?`, open a
transaction, run row logic, commit. `apply_in_txn`/`move_rows` factor part of
it; `index_meta_set`, `index_clear`, `chat_conversation_delete`,
`chat_message_save`, `embed_apply`, `embed_remove` restate it.

**Proposal.** One helper:

```rust
fn with_gated_txn<R>(
    index: &State<IndexState>,
    generation: u64,
    body: impl FnOnce(&rusqlite::Transaction) -> AppResult<R>,
) -> AppResult<Option<R>>  // None = stale generation, no-op
```

Each command shrinks to its row logic, and forgetting the gate becomes
impossible. Pure refactor; `db::tests` (incl.
`stale_generation_writes_are_dropped_end_to_end`) pin the behavior.

**Recommendation.** Do it when the file is next touched. Keep
`note_move_indexed` outside: it interleaves a filesystem rename and its own
compensation and gates on the *graph* generation, deliberately.

---

## 5. Read/write concurrency (WAL reader split) — not yet

The index uses one connection under one mutex, so a long FTS/vec read and a
write serialize. A comment in `db/mod.rs` accepted this as a first-wave tradeoff, with a
read-pool / WAL reader split possible later.

**Recommendation.** Wait for evidence of contention (e.g. UI jank during large
rebuilds). The DB already runs in WAL mode, so a read-only pool is the natural
lever, but the generation/rebind logic relies on exactly one connection, so do
not do it speculatively.

---

## Suggested sequencing

1. **#2** — done.
2. **#1 (CSP)** — highest remaining value. Own spike/PR.
3. **#3 (`ts-rs`)** — small; removes the payload skew risk.
4. **#4 (boilerplate helper)** — opportunistic.
5. **#5** — only when contention is measured.
