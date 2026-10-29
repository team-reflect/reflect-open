# TDR 0001 — Raw SQL writes over the Rust IPC bridge

- **Status:** Proposed (decision deferred — this record exists to inform it)
- **Date:** 2026-06-12
- **Scope:** The write path between the React webview and the SQLite index
  (`<graph>/.reflect/index.sqlite`). Reads are out of scope: they already ship
  Kysely-compiled `SELECT`s over the read-only `db_query` bridge.
- **Decision driver:** Could a generic, generation-gated, transactional
  `db_execute(statements, generation)` channel replace most per-feature Rust
  write commands and their serde structs, with TS composing
  `INSERT`/`UPDATE`/`DELETE` through Kysely?

---

## TL;DR

**Recommendation: keep the dedicated typed write commands. Do not add a generic
raw-SQL write channel.** Solve the type-mirroring pain with schema codegen
instead.

The generic channel would give writes the same Kysely typing reads have and
delete the hand-mirrored zod ↔ serde payload structs. But the saving is smaller
than it looks: the two hardest commands cannot be a static statement batch and
would stay, which leaves *two* write paths. The security cost is real for this
app: the webview renders untrusted markdown and LLM output, there was no CSP
at the time (`security.csp: null`), and a generic execute turns a compromised
renderer's write capability from "ten enumerable mutations" into "arbitrary
DML/DDL, including silently clearing `private: true`." No Rust-side check
constrains that back down (§4).

---

## Context: how writes worked

The index lives in Rust. The frontend reads it by compiling Kysely `SELECT`s to
`{ sql, params }` over `db_query`, which rejects anything that is not
`Statement::readonly`
([`crates/index/src/query.rs`](../../crates/index/src/query.rs), test
`db_query_rejects_mutating_statements`). The Kysely IPC dialect throws on
`beginTransaction`/`commit`/`rollback`
([`packages/db/src/dialect.ts`](../../packages/db/src/dialect.ts)): there is no
open transaction across IPC, by design.

Writes go through one `#[tauri::command]` per mutation in
[`apps/desktop/src-tauri/src/db/mod.rs`](../../apps/desktop/src-tauri/src/db/mod.rs).
Each one locks the single `IndexInner` mutex (connection and generation swap
together on graph open), silently no-ops if `state.generation != generation`,
and runs its row logic (now in [`crates/index/src/`](../../crates/index/src/)
`write.rs`, `chat_write.rs`, `embed_write.rs`) in **one transaction**.

The TS side calls them through typed wrappers (today
[`indexing/index-store-service.ts`](../../packages/core/src/indexing/index-store-service.ts),
[`ai/chat/chat-history-service.ts`](../../packages/core/src/ai/chat/chat-history-service.ts),
[`embeddings/embedding-index-service.ts`](../../packages/core/src/embeddings/embedding-index-service.ts)).
Each payload is a hand-written serde struct mirrored by a zod schema; `write.rs`
says a change on either side must be mirrored on the other.

The write-command roster:

| Command | Row logic | Static statement batch? |
|---|---|---|
| `index_apply` / `index_apply_batch` | `apply_note`: `remove` (cascade) then 7 inserts | ✅ yes |
| `index_remove` | 2 deletes (note cascade + chunks) | ✅ yes |
| `index_meta_set` | 1 upsert | ✅ yes |
| `index_clear` | `execute_batch` of deletes | ✅ yes |
| `index_move` | 8 `UPDATE … SET path` under `defer_foreign_keys` | ✅ yes (PK gives the collision check) |
| `chat_message_save` | 2 upserts, `ON CONFLICT(id)` | ✅ yes |
| `chat_conversation_delete` | 1 delete | ✅ yes |
| `embed_remove` | 2 deletes (subquery) | ✅ yes |
| **`note_move_indexed`** | row-move txn **+ filesystem rename + reverse-compensation** | ❌ **no** (FS side effect around the txn) |
| **`embed_apply`** | hash-diff: `SELECT` existing → keep/insert/delete in a loop, `last_insert_rowid()` links each vector, note-exists guard | ❌ **no** (read-then-write control flow) |

This table is the crux of the decision (§3).

---

## Options

- **A — Keep dedicated typed commands (status quo).** Row logic and invariants
  live in three audited Rust modules; payloads are serde structs mirrored to zod.
- **B — Generic `db_execute(statements, generation)`.** One command takes a
  `Vec<(sql, params)>` and runs it in one transaction under the same lock and
  gate. TS composes statements with Kysely. All per-feature write commands go.
- **C — Hybrid.** `db_execute` for the 8 batch-expressible commands; keep
  `note_move_indexed` and `embed_apply`. Option B collapses into this (§3).

---

## Analysis

### 1. How much code is actually deleted?

| Area | Lines | Notes |
|---|---:|---|
| `mod.rs` write commands (excl. `index_open`, `db_query`) | ~250 | much of it doc comments |
| `write.rs` | 203 | incl. `IndexedNote`/`IndexedLink`/`IndexedTag`/`IndexedAlias` (~50) |
| `chat_write.rs` | 93 | incl. `ChatConversation`/`ChatMessageRow` (~25) |
| `embed_write.rs` | 142 | incl. `EmbeddedChunk` + `apply_chunks` diff |
| TS write wrappers (indexing) | ~75 | excludes `openIndex`/`watchStart`/`watchStop` |
| TS write wrappers (`embedApply`/`embedRemove`) | ~18 | |
| TS write wrappers (`saveChatMessage`/`deleteChatConversation`) | ~35 | read getters and zod schemas stay |
| **Gross write surface** | **~816** | |

The generic channel deletes the 8 batch-expressible commands (~150), their
serde structs (~75; `EmbeddedChunk` stays), and `write.rs`'s
`apply_note`/`move_note`/`clear_index`/`remove_note` (~120) if that logic moves
to TS. It adds `db_execute` itself (~40–60, reusing `query.rs`'s `json_to_sql`)
and TS that builds the batches: `apply_note` becomes ~7 `insertInto` calls plus
the delete and the manual `search_fts` clear, instead of one typed `IndexedNote`
object (+100–150 TS). `note_move_indexed` and `embed_apply`, the most complex
commands, stay as they are.

**Net:** ~300–400 lines, mostly Rust, partly offset by TS growth. The simple
commands delete cleanly; the complex ones, where the lines and the risk live,
stay.

### 2. Generation gating — preservable? Yes.

`db_execute` reads the gate once before the transaction, as every command does
(`mod.rs`). The test `stale_generation_writes_are_dropped_end_to_end` would
port directly. The gate does not favor either option. One caveat: the current
commands encode which generation to pass (graph generation for FS-touching
writes, index generation for reconcile writes; see `note_move_indexed`'s doc
comment). With `db_execute`, every caller must get that right.

### 3. Atomicity and the hard cases

A statement batch gives a transaction, not read-then-write logic inside it:

- **`embed_apply` (`apply_chunks`)** selects the note's existing chunks, then
  keeps/inserts/deletes by content hash in a loop, using `last_insert_rowid()`
  to link each vector (`embed_write.rs`). Moving the diff to TS means a
  `db_query` read, a TS diff, then a batch: two IPC round trips with a gap. The
  embedding queue can race `index_remove`, and the note-exists guard in
  `embed_write.rs` exists for that race. **Stays a command.**
- **`note_move_indexed`** commits the row move, *then* renames the file, and
  runs a reverse row move if the rename fails (`mod.rs`). DB-first ordering
  makes the watcher echo benign, and the FS step sits between two DB
  operations. A batch cannot express that. **Stays a command.**
- **`move_note`'s occupied-destination check** (`SELECT 1 … WHERE path = to`)
  is mostly a friendlier error: the `notes.path` PK already fails the `UPDATE`
  on collision. So `index_move` *could* be a batch, but it would lean on a PK
  violation as the failure, the kind of dispersed invariant §5 warns about.

**Consequence:** pure Option B does not exist. Option C means **two write
paths**, one typed and audited, one free-form SQL, and the commands that remain
are the ones a reviewer most needs to understand.

### 4. Security surface

This is the decisive section, and it is specific to this app.

**The renderer is a realistic attacker.** It renders untrusted note markdown
and LLM output, with `security.csp: null`. A malicious note, a poisoned
`[[wiki link]]` title, a prompt-injected response, or a compromised npm
dependency are plausible script-execution vectors. Tauri treats the webview as
the main attack surface and the IPC boundary as the place for least privilege.

**The write surface is an enumerable allowlist.** A compromised renderer can
call ten mutations, each validating a typed payload and running fixed SQL. It
cannot `DROP`, `ALTER`, `ATTACH DATABASE`, write `chat_*` rows in shapes the
app never produces, or run `UPDATE notes SET is_private = 0` to strip the
privacy block and exfiltrate notes.

**A generic `db_execute` removes that boundary.** Renderer SQL is arbitrary DML
and, unless filtered, DDL. `is_private` is what query-time privacy filters
read, and AGENTS.md makes `private: true` a hard block enforced at every call
site. Making it renderer-writable contradicts that.

**The middle grounds do not claw it back:**

- *"Kysely-compiled-only writes"* is unenforceable: Rust receives a string, and
  compilation happens in the renderer being defended against.
- *Statement-shape allowlisting* means a SQL firewall in Rust. Safe parsing is
  a known footgun (comments, CTEs, `RETURNING`, sub-selects, `PRAGMA`,
  multi-statement strings); one gap is a full bypass, and it recreates the
  enumeration typed commands give for free.
- *Per-table grants* must permit `notes`/`links`/`tags`, the writes we would
  move, so `UPDATE notes SET is_private = 0` is back. SQLite has no
  column-level grants.

Only a fixed set of typed commands constrains a compromised renderer. The read
side already follows this principle: `db_query` rejects non-readonly statements
because we do not trust the renderer. A write channel that trusts renderer SQL
is inconsistent with that.

### 5. Where do the invariants live?

These rules live in one audited place; under B/C every TS call site must
compose them:

- **Chat upserts use `ON CONFLICT(id)`, never `INSERT OR REPLACE`**, so a
  `(conversation_id, seq)` collision fails loudly instead of silently deleting
  another turn (`chat_write.rs`, pinned by
  `chat_message_seq_collision_errors_instead_of_replacing`).
- **Conversation `title`/`created_ms` are fixed at insert**; the upsert bumps
  only `updated_ms`.
- **`apply_note` relies on `ON DELETE CASCADE`** and clears the FTS table
  explicitly (it has no FK). A TS batch that forgets leaves stale search rows.
- **`move_note` defers foreign keys** so the parent key moves before children.
- `write.rs` documents the schema's FKs as the single source of truth for
  cleanup; dispersing writes to TS dissolves that.

None of this is impossible in TS, but it trades centralized, unit-tested rules
for "every call site writes correct SQL." Where the failure is silent data loss
(`INSERT OR REPLACE`), that is a bad trade.

### 6. Prior art

> _Gathered by a research sub-agent (web search + source/docs reading).
> Inferred items are flagged; see Open questions._

- **`tauri-plugin-sql`** exposes raw `execute(db, query, params)` straight to
  sqlx (`plugins/sql/src/commands.rs` @ `v2`). Its permissions are eight
  command-level toggles (`allow`/`deny` × `load`/`execute`/`select`/`close`),
  with no per-table or per-statement scoping. The default set is read-only;
  writes need `sql:allow-execute`. The docs have no untrusted-webview warning.
  It suits only apps whose renderer shows no untrusted content, which Reflect
  cannot assume. (It confines the DB file to `app_config_dir()`, which does not
  constrain SQL against that DB.)
- **Tauri's security model** says *"We assume the webview is insecure"*.
  Capabilities gate which commands a window may call, not the contents of a
  call. The Isolation Pattern (a sandboxed iframe validating every IPC message)
  is the escape hatch, and validating free-form SQL there is far harder than a
  typed payload. Recent CVEs (**CVE-2026-42184**, origin confusion letting
  remote pages call local-only commands; **CVE-2024-35222**, iframe
  origin-check bypass) show the threat recurs: if the reachable command is
  `db_execute(sql)`, the whole DB is the attacker's in one call.
- **Signal Desktop** puts no SQL on the wire: two channels
  (`sql-channel:read`, `sql-channel:write`) carry a method name and args,
  dispatched against a whitelist that rejects unknown methods. That is Option A,
  motivated by Signal's own renderer XSS→RCE history (CVE-2018-11101).
- **Joplin**, an untrusted-markdown note app, shipped several XSS→RCE CVEs
  from rendering (CVE-2018-1000534, CVE-2022-40277, CVE-2024-49362), so
  "assume the renderer is compromised" is the right default for this app class.
  Electron's hardening checklist (item 20) says not to expose IPC directly to
  untrusted content.
- **In-renderer SQLite** (`wa-sqlite`/`absurd-sql`, Logseq DB, Notion web) puts
  the DB inside the untrusted zone. Reflect rejected that (Plan 04: the native
  process holds the graph write lock). Since the DB stays in Rust on purpose,
  the boundary should stay meaningful; `db_execute` would partly recreate the
  in-renderer situation.

**Synthesis.** Raw SQL over IPC ships (`tauri-plugin-sql`) but is off by
default, all-or-nothing, and assumes a trusted frontend. Apps that render
untrusted content converge on typed, whitelisted write channels, and Reflect is
in that bucket. (Caveat: no single CVE shows a SQL bridge exploited; the risk is
inferred from XSS/origin CVEs and these apps' choices.)

---

## Recommendation

**Keep the dedicated typed write commands (Option A).** In priority order:

1. **Security dominates.** No CSP, untrusted markdown and LLM output, and the
   `private: true` hard block make an enumerable allowlist of typed commands
   worth keeping. No Rust filter restores it once raw SQL is allowed.
2. **The saving is partial and creates two write paths.** The two highest-risk
   commands stay anyway; ~300–400 lines net is not worth the trade.
3. **Invariants stay centralized** (`ON CONFLICT(id)`, fixed conversation
   title, cascade plus explicit FTS clear, deferred FKs), where getting them
   wrong would mean silent data loss.

**Address the real pain another way:**

- **Generate the serde payload structs (or the zod schemas) from one source.**
  The read schema is already codegen'd (`packages/db/src/schema.gen.ts` from the
  migrations); extend that to write payloads.
- **Factor the command boilerplate, not the commands.** Lock, gate and `tx`
  scaffolding are already shared via `apply_in_txn`/`move_rows`; a macro or
  helper could remove the rest while each mutation stays a typed entry point.

**If a generic channel is ever revisited**, restrict it to non-sensitive,
append-only-ish tables (e.g. `index_meta`), never `notes` (`is_private`) or
`chat_*` (`ON CONFLICT(id)`), and weigh it against the one-line command it
replaces.

---

## What we give up by keeping commands

- **Per-mutation boilerplate:** each new write needs a command, a serde struct
  and a zod wrapper (codegen mitigates).
- **No end-to-end type safety on writes:** drift is caught by serde rejection
  and payload-shape tests, not at TS compile time (codegen mitigates).
- **Hand-written SQL column lists** in `write.rs`, so a schema change touches
  two languages. This is inherent to SQLite in Rust, and `db_execute` would not
  fix it for the hard cases.

These costs are bounded and do not silently corrupt or exfiltrate data. The
generic channel trades them for costs that can.

---

## Open questions

1. **`tauri-plugin-sql` permission granularity:** answered for v2
   (command-level only, write off by default). Re-check if this is reconsidered.
2. **`db_execute` as a `#[cfg(test)]` convenience** for seeding fixtures, where
   renderer trust does not apply? Low stakes.
3. **Is the codegen direction (Rust→zod or zod→Rust) worth its own spike?** It
   is the useful half of this investigation.
4. **Should `csp: null` be tightened regardless?** A real CSP reduces, not
   removes, renderer-compromise risk, and deserves its own TDR. This
   recommendation does not depend on it.
