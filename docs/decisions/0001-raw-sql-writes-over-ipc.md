# TDR 0001 — Raw SQL writes over the Rust IPC bridge

- **Status:** Proposed (decision deferred — this record exists to inform it)
- **Date:** 2026-06-12
- **Scope:** The write path between the React webview and the SQLite index
  (`<graph>/.reflect/index.sqlite`). Reads are out of scope — they already ship
  Kysely-compiled `SELECT`s over the read-only `db_query` bridge and that is not
  in question.
- **Decision driver:** Could a generic, generation-gated, transactional
  `db_execute(statements, generation)` channel let us delete most of the
  per-feature Rust write commands and their serde structs, with TS composing
  `INSERT`/`UPDATE`/`DELETE` through Kysely for type safety?

---

## TL;DR

**Recommendation: keep the dedicated typed write commands. Do not add a generic
raw-SQL write channel.** Pursue the boilerplate/type-mirroring pain it was
meant to solve through schema codegen instead (see
[Recommendation](#recommendation)).

The generic channel is genuinely attractive on two axes — it would give writes
the same end-to-end Kysely typing reads enjoy, and it would delete the
hand-mirrored TS-zod ↔ Rust-serde payload structs. But the simplification is
smaller than it first looks (the two hardest commands can't be expressed as a
static statement batch and would stay, leaving us with *two* write paths), and
the security cost is real and specific to this app: the webview renders
untrusted markdown and untrusted LLM output, there is **no CSP**
(`tauri.conf.json` → `security.csp: null`), and a generic execute turns a
compromised renderer's write capability from "ten enumerable mutations" into
"arbitrary DML/DDL, including silently clearing `private: true`." There is no
Rust-side enforcement that meaningfully constrains that back down (see
[§4](#4-security-surface)).

---

## Context: how writes work today

The index lives in Rust. The frontend reads it by compiling Kysely `SELECT`s to
`{ sql, params }` and shipping them over `db_query`, which executes them against
a `rusqlite::Connection` and rejects anything that isn't `Statement::readonly`
([`crates/index/src/query.rs:49`](../../crates/index/src/query.rs),
test `db_query_rejects_mutating_statements`). The Kysely IPC dialect
deliberately throws on `beginTransaction`/`commit`/`rollback`
([`packages/db/src/dialect.ts:59`](../../packages/db/src/dialect.ts)) — there is
no open-transaction-across-IPC, by design.

Writes go through one `#[tauri::command]` per mutation in
[`apps/desktop/src-tauri/src/db/mod.rs`](../../apps/desktop/src-tauri/src/db/mod.rs).
Every write:

1. Locks the single `IndexInner` mutex (connection + generation kept under one
   lock so they swap atomically on graph open).
2. **Generation-gates**: `if state.generation != generation { return Ok(()) }` —
   a write issued for a now-superseded graph silently no-ops.
3. Runs its row logic (in [`write.rs`](../../crates/index/src/write.rs),
   [`chat_write.rs`](../../crates/index/src/chat_write.rs),
   [`embed_write.rs`](../../crates/index/src/embed_write.rs)) inside
   **one transaction**.

The TS side calls these through typed wrappers
(`packages/core/src/indexing/commands.ts`, `packages/core/src/ai/chat/store.ts`,
`packages/core/src/embeddings/commands.ts`; today these are
[`indexing/index-store-service.ts`](../../packages/core/src/indexing/index-store-service.ts),
[`ai/chat/chat-history-service.ts`](../../packages/core/src/ai/chat/chat-history-service.ts) and
[`embeddings/embedding-index-service.ts`](../../packages/core/src/embeddings/embedding-index-service.ts)),
each passing a payload that a hand-written serde struct on the Rust side
deserializes. The payload contract is mirrored by hand on both sides — the code
says so explicitly:

> Mirrors the `indexedNoteSchema` zod contract … field-for-field … a change on
> either side must be mirrored on the other. — `write.rs:14`

The full write-command roster:

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
| **`note_move_indexed`** | row-move txn **+ filesystem rename + reverse-compensation** | ❌ **no** (FS side effect between/around the txn) |
| **`embed_apply`** | hash-diff: `SELECT` existing → keep/insert/delete in a loop, `last_insert_rowid()` links each vector, note-exists guard | ❌ **no** (read-then-write control flow) |

This table is the crux of the whole decision and is analysed in
[§3](#3-atomicity-and-the-hard-cases).

---

## Options

### Option A — Keep dedicated typed commands (status quo)

One `#[tauri::command]` per mutation; row logic and invariants centralized in
three audited Rust modules; payloads typed by serde structs mirrored to zod.

### Option B — Generic `db_execute(statements, generation)`

A single command takes a `Vec<(sql, params)>`, opens one transaction under the
same lock + generation gate, executes each statement, commits. TS composes the
statements with Kysely (`insertInto`/`updateTable`/`deleteFrom`), getting writes
the same typed query-builder treatment reads have. All per-feature write
commands and their serde structs are deleted.

### Option C — Hybrid

`db_execute` for the statements that *are* expressible as static batches (8 of
the 10 commands); keep dedicated commands for the two that aren't
(`note_move_indexed`, `embed_apply`). This is what Option B actually collapses
into once you account for [§3](#3-atomicity-and-the-hard-cases) — pure B is not
achievable.

---

## Analysis

### 1. How much code is actually deleted?

Honest line counts for the write surface (code + doc comments, as they stand):

| Area | Lines | Notes |
|---|---:|---|
| `mod.rs` write commands (excl. `index_open`, `db_query`) | ~250 | a lot of it is doc comments |
| `write.rs` | 203 | incl. `IndexedNote`/`IndexedLink`/`IndexedTag`/`IndexedAlias` serde structs (~50) |
| `chat_write.rs` | 93 | incl. `ChatConversation`/`ChatMessageRow` structs (~25) |
| `embed_write.rs` | 142 | incl. `EmbeddedChunk` struct + `apply_chunks` diff |
| TS write wrappers (`indexing/commands.ts` write subset) | ~75 | excludes `openIndex`/`watchStart`/`watchStop` |
| TS write wrappers (`embeddings/commands.ts` `embedApply`/`embedRemove`) | ~18 | |
| TS write wrappers (`ai/chat/store.ts` `saveChatMessage`/`deleteChatConversation`) | ~35 | the read getters + zod schemas stay |
| **Gross write surface** | **~816** | plus serde structs counted within |

What the generic channel **deletes**:

- The 8 batch-expressible commands in `mod.rs` (~150 lines incl. comments).
- The serde structs for those payloads: `IndexedNote` + 3 friends (~50),
  `ChatConversation` + `ChatMessageRow` (~25). `EmbeddedChunk` **stays**
  (`embed_apply` stays).
- `write.rs`'s `apply_note`/`move_note`/`clear_index`/`remove_note` (~120) —
  *if* their logic moves to TS-composed batches.
- The thin TS wrappers, replaced by Kysely-composed statement builders.

What it **adds**:

- The `db_execute` command itself: lock, gate, loop, bind params (reusing
  `query.rs`'s `json_to_sql`), one transaction, commit. ~40–60 lines.
- TS that composes the statement batches. `apply_note` becomes ~7 Kysely
  `insertInto` calls plus the `delete` + the manual `search_fts` clear, built at
  the call site instead of one typed `IndexedNote` object. Net TS roughly
  *grows* — the typed object you pass today (`{ note, generation }`) becomes a
  hand-built array of compiled statements. Estimate +100–150 lines TS.

What it **keeps** (and therefore does *not* simplify):

- `note_move_indexed` (FS compensation) and `embed_apply` (hash-diff) — the two
  most complex commands, with the densest invariants, stay exactly as they are.

**Net:** a real but modest deletion — on the order of **300–400 lines net**,
concentrated in Rust, partially offset by TS growth. This is *not* the "vast
simplification" the question hoped for, because the simplest commands (a 1-line
upsert like `index_meta_set`) are the ones that delete cleanly, while the
complex ones — where the lines and the risk actually live — stay.

### 2. Generation gating — preservable? Yes.

The gate is `state.generation != generation` under the lock. A generic
`db_execute(statements, generation)` reads the gate once, before the
transaction, exactly like every command does today
([`mod.rs:101`](../../apps/desktop/src-tauri/src/db/mod.rs)). No semantics are
lost; the existing end-to-end test
(`stale_generation_writes_are_dropped_end_to_end`) would port directly. **The
gate is not an argument for or against either option.** (One caveat: today the
gate is impossible to *forget* — it's in every command. With `db_execute`, the
gate lives in one place, which is arguably safer, but every *caller* must
remember to thread the right generation — graph-generation for FS-touching
writes vs index-generation for reconcile writes, a distinction the current
commands encode for you. See `note_move_indexed`'s doc comment on which
generation it gates.)

### 3. Atomicity and the hard cases

A statement-batch API gives you a transaction. It does **not** give you
read-then-write logic inside that transaction. Three commands need exactly that:

- **`embed_apply` (`apply_chunks`)** — `SELECT` the note's existing chunk rows,
  then in a loop decide keep/insert/delete by content hash, calling
  `last_insert_rowid()` to wire each new vector to its chunk
  ([`embed_write.rs:44`](../../crates/index/src/embed_write.rs)).
  This is irreducibly read-then-write with control flow and rowid sequencing. It
  *cannot* be a static statement array. Could the diff move to TS? Only by
  reading existing chunks over `db_query`, computing the diff in TS, then sending
  a batch — which splits one atomic operation across two IPC round-trips with a
  read gap in the middle. The embedding pipeline runs on its own queue and can
  race `index_remove`; that gap is a TOCTOU window the current single-command
  atomicity closes (the note-exists guard at `embed_write.rs:53` exists *because*
  of this race). Moving it to TS reintroduces the race. **Stays a command.**

- **`note_move_indexed`** — moves the index rows in a committed transaction,
  *then* renames the file on disk, and if the rename fails, runs a reverse
  row-move to compensate ([`mod.rs:172`](../../apps/desktop/src-tauri/src/db/mod.rs)).
  The DB-first ordering is load-bearing (it makes the watcher's echo benign) and
  the FS side effect sits *between* two DB operations. A statement batch has no
  notion of "commit, do a filesystem thing, maybe roll forward." **Stays a
  command.**

- **`move_note`'s occupied-destination check** — a `SELECT 1 … WHERE path = to`
  guard before the `UPDATE`. This one is *partly* reducible: the `notes.path`
  primary key already makes `UPDATE notes SET path = to` fail on collision, so
  the explicit probe is mostly there for a friendlier error. So `index_move`
  *could* become a batch — but it would lean on a PK violation surfacing as the
  failure, which is exactly the kind of invariant this TDR worries about
  dispersing (see §5).

**Consequence:** "pure Option B" does not exist. The realistic outcome is
Option C — a generic channel **plus** retained commands for the hard cases —
which means **two write paths**: one typed-and-audited, one free-form-SQL. Two
paths is a worse maintenance and review story than one, and it undercuts the
"delete most of the commands" premise: the commands that remain are the ones a
reviewer most needs to understand.

### 4. Security surface

This is the decisive section, and it is specific to *this* app rather than a
generic objection.

**The renderer is a realistic attacker.** The webview renders untrusted note
markdown and untrusted LLM chat output, and `tauri.conf.json` sets
`security.csp: null` — there is no Content-Security-Policy constraining script
execution or exfiltration today. A malicious note, a poisoned `[[wiki link]]`
title, a prompt-injected model response, or a compromised npm dependency in the
renderer bundle are all plausible XSS/script-execution vectors. Tauri's own
security model treats the webview as the primary attack surface and the IPC
boundary as the place to enforce least privilege — capabilities gate *which
commands* a window may call, precisely so the native side never has to trust the
renderer's intent.

**Today the write surface is an enumerable allowlist.** A compromised renderer
can call exactly ten mutations, each of which validates a typed payload and runs
fixed SQL. It cannot `DROP TABLE`, it cannot `ALTER`, it cannot `UPDATE notes SET
is_private = 0` to strip the hard privacy block off every note and then read them
out for exfiltration, it cannot `ATTACH DATABASE`, it cannot write the
`chat_*` tables in shapes the app never produces.

**A generic `db_execute` removes that boundary.** Free-form SQL from the renderer
is arbitrary DML — and, unless explicitly filtered, arbitrary DDL. The
`private: true` exfiltration path (`UPDATE notes SET is_private = 0`) is the
sharpest example: AGENTS.md calls `private: true` "a hard block … Enforce at
every call site," and the index's `is_private` column is what query-time
privacy filters read. Making it writable by arbitrary renderer SQL is a direct
contradiction of a stated product non-negotiable.

**Can the middle grounds claw it back? Mostly no, Rust-side:**

- *"Kysely-compiled-only writes."* Unenforceable. Rust receives a string; it
  cannot tell a Kysely-compiled `INSERT` from a hand-written one, because the
  compilation happens in the very renderer you're trying to defend against. "We
  only *intend* to send Kysely output" is a TS-side convention, not a boundary.
- *Statement-shape allowlisting* (parse the SQL, permit only certain
  table/operation combinations). This is building a SQL firewall in Rust —
  parsing SQL well enough to be safe is a notorious footgun (comments, CTEs,
  `RETURNING`, sub-selects, `PRAGMA`, multi-statement strings). High effort,
  fragile, and one parser gap = full bypass. It also recreates, in a worse form,
  the very enumeration the typed commands give you for free.
- *Per-table grants* (e.g. "renderer may write `chat_*` but not `notes`"). Helps
  for tables the renderer should never touch, but the writes we'd want to move to
  `db_execute` are exactly the `notes`/`links`/`tags` writes — so the grant would
  have to permit them, and `UPDATE notes SET is_private = 0` is back on the table
  (literally). Column-level grants are not a thing SQLite enforces for us.

The only mechanism that actually constrains a compromised renderer to safe
mutations is: **the write surface is a fixed set of typed commands.** That is
what we have. `db_query`'s `Statement::readonly()` rejection is the read-side
embodiment of the same principle — we deliberately do *not* trust the renderer
not to send a mutating `SELECT`. A write channel that trusts the renderer's SQL
is inconsistent with the posture we already adopted for reads.

### 5. Where do the invariants live?

Several correctness rules currently live in exactly one audited place. Under
Option B/C they would be composed in TS at every call site:

- **`chat upserts use `ON CONFLICT(id)`, never `INSERT OR REPLACE`** — so a
  `(conversation_id, seq)` unique collision fails *loudly* instead of silently
  deleting a different turn. Encoded once in `chat_write.rs:48`; there is a test
  (`chat_message_seq_collision_errors_instead_of_replacing`) that pins it. In TS
  this becomes the call site's responsibility to write the right `ON CONFLICT`
  clause every time.
- **Conversation `title`/`created_ms` fixed at insert** (the upsert bumps only
  `updated_ms`). Encoded in the one upsert; trivially forgotten if hand-composed.
- **`apply_note` relies on `ON DELETE CASCADE`** for child cleanup and clears the
  FTS virtual table *explicitly* (it has no FK). A TS-composed batch must
  remember the FTS clear or leave stale search rows.
- **`move_note` defers foreign keys** so the parent key can move before children.
- **The cascade/FTS contract self-documents** via `write.rs`'s comment that the
  schema's FKs — "not a hand-maintained DELETE list here — are the single source
  of truth." Dispersing the writes to TS dissolves that single source of truth.

None of these are impossible in TS. The point is that today they are
*centralized, commented, and unit-tested at the Rust seam*, and the generic
channel trades that for "every call site composes correct SQL." For invariants
whose failure mode is *silent data loss* (the `INSERT OR REPLACE` one), that is a
bad trade.

### 6. Prior art

> _The findings below were gathered by a research sub-agent (web search +
> source/docs reading). Items where the evidence is inferred rather than direct
> are flagged; see [Open questions](#open-questions)._

- **`tauri-plugin-sql`** (the official plugin) **does** expose a raw
  `execute(db, query, params)` — the frontend passes an arbitrary SQL string
  straight through to sqlx (verified in `plugins/sql/src/commands.rs` @ `v2`).
  Its entire permission surface is **eight command-level toggles**
  (`allow`/`deny` × `load`/`execute`/`select`/`close`) — there is **no
  per-database, per-table, per-statement, or per-verb scoping**. Two details
  matter for us: (a) the **default permission set is read-only** (`allow-load`,
  `allow-select`, `allow-close`) — writes require explicitly adding
  `sql:allow-execute`, so even Tauri's own plugin treats renderer writes as
  opt-in; (b) the docs ship **no SQL-injection / untrusted-webview warning** —
  the security story is delegated entirely to "don't grant `allow-execute` if you
  don't want writes." It is acceptable practice **only for apps whose renderer is
  trusted and renders no untrusted content** — exactly the assumption Reflect
  cannot make (untrusted markdown + LLM output, `csp: null`). (Mild mitigation:
  the plugin confines the DB file to `app_config_dir()`, so `load()` can't point
  at arbitrary paths — but that doesn't constrain SQL run against the allowed DB.)
- **Tauri's security model** is explicit that the webview is hostile —
  verbatim: *"We assume the webview is insecure, which has led Tauri to implement
  several protections regarding webview access to system APIs in the context of
  loading untrusted userland content"* (security lifecycle docs). Capabilities
  gate *which commands* a window may invoke — **not the contents of an allowed
  call**. Tauri's escape hatch for "you can't trust the frontend" is the
  **Isolation Pattern** (a sandboxed iframe that validates every IPC message),
  which exists *"out of threats coming from untrusted content running on the
  frontend, a common case for applications with many dependencies."* Validating
  free-form SQL in such a sandbox is far harder than validating a typed
  `{op, path, fields}` payload — another structural argument for typed commands.
  Recent Tauri CVEs confirm the "untrusted/remote content reaches commands the
  dev thought were private" threat is real and recurring (e.g.
  **CVE-2026-42184**, origin confusion letting remote pages invoke local-only IPC
  commands; **CVE-2024-35222**, iframe origin-check bypass). The chain is: an XSS
  or origin-confusion bug lets an attacker invoke whatever command is reachable —
  if that command is `db_execute(sql)`, the whole DB (read, tamper, `ATTACH` to
  exfiltrate, destroy) is theirs in one allowed call.
- **Signal Desktop** is the strongest reference and lands directly on the typed
  side. It does **not** put SQL on the wire: the renderer↔main bridge has exactly
  two SQL channels (`sql-channel:read`, `sql-channel:write`) that carry a
  **method name + serialized args, never SQL text**, dispatched against a fixed
  interface that *rejects any method not on the whitelist* (`Invalid sql
  method`). This is precisely the "dedicated typed write commands" posture,
  read/write-split, implemented as a method-dispatch table — and it was motivated
  by Signal's own renderer XSS→RCE history (CVE-2018-11101, HTML injection in
  quoted replies). The most security-conscious mainstream Electron app in this
  class chose exactly Option A.
- **Joplin** — an untrusted-markdown note app like Reflect — shipped a string of
  XSS→RCE CVEs from content rendering (CVE-2018-1000534, CVE-2022-40277,
  CVE-2024-49362). The lesson isn't SQL-specific: it establishes that
  markdown-rendering note apps are a *proven* injection target, making "assume
  the renderer is compromised" the correct default for our exact app class.
  Electron's official hardening checklist item 20 states the general rule
  directly: *"do not directly expose Electron's APIs, especially IPC, to
  untrusted web content"* — expose narrow, wrapped, specific operations instead.
- **In-renderer SQLite (`wa-sqlite`/`absurd-sql`, and Logseq's DB version /
  Notion web)** dissolves the question differently — the DB lives *inside* the
  untrusted zone, so there's no IPC boundary to protect (a renderer XSS owns the
  DB by construction). Reflect explicitly rejected this (Plan 04: the native
  process must hold the graph write lock; a wa-sqlite VFS bridging pages over IPC
  "reintroduces Rust into the data path"). Since we keep the DB in Rust *on
  purpose*, the boundary is worth keeping meaningful — a generic `db_execute`
  would partially recreate the "DB in the untrusted zone" situation with extra
  steps.

**Synthesis.** Raw-SQL-over-IPC exists and ships (`tauri-plugin-sql`), but it is
*supported, not blessed*: off by default, gated only at all-or-nothing command
granularity, shipped with no compromised-webview guidance — acceptable only under
a "trusted first-party frontend, no untrusted content" assumption Reflect's
threat model explicitly violates. The security-conscious local-first apps that
render untrusted content converge on **typed, whitelisted write channels**
(Signal being the clearest exemplar). Reflect is squarely in the "renders
untrusted content" bucket, which puts it on the typed-command side of the
consensus. (Evidence caveat: there is no *single* CVE for a SQL-bridge design
flaw being exploited — the risk is inferred from the well-documented XSS/origin
CVEs plus the architectural choices these apps made, not from a smoking gun.)

---

## Recommendation

**Keep the dedicated typed write commands (Option A). Do not introduce a generic
`db_execute` write channel.**

Reasoning, in priority order:

1. **Security dominates.** `csp: null` + untrusted markdown + untrusted LLM
   output + a stated `private: true` hard block make "the write surface is an
   enumerable allowlist of typed commands" a security property worth keeping. No
   Rust-side filter restores it once raw SQL is allowed, and "Kysely-only" is
   unenforceable across the trust boundary.
2. **The simplification is partial and creates two write paths.** The two
   highest-risk commands (`note_move_indexed`, `embed_apply`) can't be static
   batches and stay regardless, so we'd carry both a free-form path *and* the
   commands that most need review. Net deletion is ~300–400 lines, much of it
   offset by new TS statement-composition code — not the order-of-magnitude win
   that would justify the trade.
3. **Invariants stay centralized.** `ON CONFLICT(id)` not `INSERT OR REPLACE`,
   fixed conversation title, cascade-plus-explicit-FTS-clear, deferred FKs —
   these stay in one audited, unit-tested place instead of being recomposed at
   every TS call site, where the failure mode of getting them wrong is silent
   data loss.

**Address the real pain a different way.** The legitimate motivation behind the
question — the hand-mirrored TS-zod ↔ Rust-serde payload structs ("a change on
either side must be mirrored on the other") and the lack of write-side type
safety — is worth fixing, just not by opening raw SQL:

- **Generate the serde payload structs (or the zod schemas) from one source** so
  the mirror can't skew. The read schema is already codegen'd
  (`packages/db/src/schema.gen.ts` from the migrations); extend that discipline
  to write payloads. This kills the duplication without widening the attack
  surface.
- **Factor the command boilerplate**, not the commands. The lock + gate + `tx`
  scaffolding is already shared via `apply_in_txn`/`move_rows`; a small macro or
  helper could remove the remaining per-command repetition while keeping each
  mutation an enumerable, typed entry point.

**If a generic channel is ever revisited**, scope it as Option C restricted to
**non-sensitive, append-only-ish tables** (e.g. `index_meta`) where neither
privacy nor silent-overwrite invariants apply — and never to `notes` (the
`is_private` column) or `chat_*` (the `ON CONFLICT(id)` invariant). Even then,
weigh it against simply keeping the one-line command it would replace.

---

## What we give up by keeping commands

To be honest about the cost of the recommendation:

- **Per-mutation boilerplate.** Each new table that needs a write gets a new
  command + serde struct + zod wrapper. (Mitigated by the codegen suggestion.)
- **No end-to-end type safety on writes.** Writes are typed by serde structs
  mirrored to zod by hand, not by Kysely's compiler. Reads have it; writes
  don't. (Mitigated by codegen; a write that drifts is caught by serde
  rejection + the payload-shape tests, not at TS compile time.)
- **The migration's column lists are hand-written SQL** in `write.rs` rather than
  Kysely-built. A schema change touches two languages. (This is inherent to
  SQLite-runs-in-Rust and would only partly improve under `db_execute`, since the
  hard cases keep hand-written SQL anyway.)

These are real but bounded, and they are the *kind* of cost — extra typing,
local duplication — that does not silently corrupt user data or exfiltrate
private notes. The generic channel trades them for costs that can.

---

## Open questions

1. **`tauri-plugin-sql` permission granularity — answered, monitor for change.**
   As of v2 it is command-level only (8 `allow`/`deny` toggles), write off by
   default, no statement/table scoping, no threat-model docs. Re-check if we ever
   reconsider, since plugin docs/permissions can change.
2. **Would we ever want `db_execute` purely as an internal/test convenience**
   (e.g. seeding fixtures) behind `#[cfg(test)]`, where the renderer-trust
   argument doesn't apply? Low stakes; worth a line in the test utilities if it
   reduces test setup.
3. **Is the codegen direction (Rust→zod or zod→Rust) worth its own spike?** It is
   the actually-useful half of this investigation and deserves sizing
   independently of the raw-SQL question.
4. **Should `csp: null` be tightened regardless of this decision?** It is the
   premise that makes the security argument sharp; a real CSP would reduce (not
   eliminate) the renderer-compromise risk and is worth its own TDR. The raw-SQL
   recommendation should not depend on CSP being fixed, but the two interact.
