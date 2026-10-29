# Security Pass – Findings

Branch: `claude/security-pass-20260615`  
Reviewer: Claude (claude-sonnet-4-6)  
Date: 2026-06-15

---

## Fixed in this pass

### SEC-01 · No Content Security Policy · **High** · Fixed

**Location:** `apps/desktop/src-tauri/tauri.conf.json`  
**Exploitability:** Moderate (requires clicking a crafted link)

`"csp": null` let a `javascript:` link rendered by the editor run in the
WebView, with full access to the Tauri IPC bridge. An attacker who can write to
a synced note (e.g. a shared git repository) could call `invoke('secret_get', ...)`
to extract BYOK API keys, or `invoke('note_write', ...)` to overwrite notes.

**Fix:** a restrictive CSP. `script-src 'self'` blocks `javascript:` URI
execution (CSP applies to `javascript:` navigation); `style-src` keeps
`'unsafe-inline'` for the editor's inline styles; `img-src` allows the asset
protocol; `connect-src` is limited to Tauri IPC and the AI/GitHub endpoints the
HTTP capability already gates.

---

### SEC-02 · Gist URL scheme not validated before `openUrl()` · **Medium** · Fixed

**Location:** `apps/desktop/src/components/context-sidebar/published-url-section.tsx`  
**Exploitability:** Easy (frontmatter edit + open sidebar)

The frontmatter gist URL went straight to `openUrl()`, so
`gist: {url: "file:///etc/passwd", ...}` opened an arbitrary path with the OS
default handler when the user viewed the context sidebar. `gistFrontmatterSchema`
accepted any string.

**Fix (two layers):** `gistFrontmatterSchema.url` requires `http(s)://`, and an
invalid URL degrades the gist block to `undefined` (the existing
`.catch(undefined)` pattern). `openPublishedUrl` also checks
`url.startsWith('https://')`. Test: "rejects a non-http(s) gist url, degrading
to 'never published'" in `packages/core/src/markdown/frontmatter.test.ts`.

---

### SEC-03 · Private notes surface in "Similar Notes" sidebar · **High** · Fixed

**Location:** `packages/core/src/embeddings/retrieve.ts`  
**Exploitability:** Easy (automatic, no click required)

`relatedNotes()` returned every KNN neighbor, including `private: true` notes,
so a private note's title (sensitive on its own) showed in "Similar notes".

**Fix:** `AND n.is_private = 0` in the neighbor query.

---

### SEC-04 · GitHub Actions: workflow_dispatch input interpolated into shell · **Low** · Fixed

**Location:** `.github/workflows/release.yml`  
**Exploitability:** Theoretical (input is typed boolean)

`${{ inputs.draft && '--draft' || '' }}` was interpolated into `run:`. The input
is boolean, but direct interpolation is the pattern that becomes injection if
the input type or source changes.

**Fix:** set it as `DRAFT_FLAG` in the step's `env:` and use `$DRAFT_FLAG`.

---

### SEC-05 · `shadcn` CLI in `dependencies` pulls network-capable dev tooling into prod closure · **Medium** · Fixed

**Location:** `apps/desktop/package.json`  
**Exploitability:** Low (no runtime exposure in the Tauri app)

`shadcn@4.11.0` is a dev-time code generator. Under `dependencies` it pulled
`@dotenvx/dotenvx` (a `.env` processor with a shell binary) and
`@modelcontextprotocol/sdk` 1.29.0 (an MCP network client) into the production
closure. Neither is used at runtime.

**Fix:** moved `shadcn` to `devDependencies`.

---

### SEC-06 · `.gitignore` missing `.env` pattern · **Low** · Fixed

**Location:** `.gitignore`  
**Exploitability:** Easy (accidental commit)

**Fix:** added `.env`, `.env.*`, and `!.env.example`.

---

### SEC-07 · GitHub auth step: `verificationUri` not scheme-validated before `openUrl()` · **Low** · Fixed

**Location:** `apps/desktop/src/components/settings/github-auth-step.tsx`  
**Exploitability:** Theoretical (MitM on GitHub API required)

`flow.verificationUri` from the device-flow API went straight to `openUrl()`.
The HTTP capability allows only `https://github.com/...`, so a bad value needs a
compromised API or MitM.

**Fix:** a `startsWith('https://')` guard, the same defence-in-depth as SEC-02.

---

## Deferred recommendations

| ID | Finding | Reason for deferral |
|---|---|---|
| D-01 | Private notes indexed into `embedding_chunks` / `embedding_vectors` | A fix in `backfillEmbeddings()` also needs retroactive deletion of existing private-note vectors and a transition when `private:` toggles. Large scope; SEC-03 blocks the UI exposure. |
| D-02 | Devtools feature compiled into release builds | Intentional (see the `src/devtools.rs` comment). Low marginal risk given the CSP. |
| D-03 | `capture_meta_fetch` can reach internal network endpoints | Mitigated by a 512 KB cap, 5-redirect limit, 15 s timeout and HTML-only content-type check. The capture envelope's `z.url().refine(isHttpUrl)` already rejects non-http(s). |
| D-04 | `secret_set`/`secret_get` accept unconstrained keychain entry names | Needs a compromised WebView; blocked by the CSP. A static allowlist is good defence-in-depth but a larger Rust+TS change. |
| D-05 | `graph_open`/`graph_create` accept arbitrary absolute paths | By design: the user picks the graph folder. No traversal within a graph is possible (`resolve.rs`). |
| D-06 | `HF_ENDPOINT` env var can redirect model download | Could be gated behind `#[cfg(debug_assertions)]`. Needs a process environment variable. |
| D-07 | `prebuild-install` (transitive dep of `better-sqlite3`) deprecated | Track `better-sqlite3` releases for a maintained alternative. |
| D-08 | Release workflow credential exposure during `pnpm install` | Splitting build/publish jobs would remove it; non-trivial restructuring. |
| D-09 | `spike_mobile.rs` instrumentation in production mobile binary | Marked `TEMPORARY`; remove when the Plan 19 spike concludes. (The file has since been removed.) |

---

## Surfaces confirmed safe (no action needed)

| Surface | Evidence |
|---|---|
| **Path traversal** | `resolve.rs` (now `crates/graph-io/src/resolve.rs`): lexical guard (rejects `..`, absolute paths) + canonical symlink check, unit-tested including symlink escape. |
| **SQL injection** | IPC-facing queries are parameterized (Kysely/rusqlite). `db_query` also blocks `ATTACH`/`DETACH`/`PRAGMA` via a SQLite authorizer. |
| **Supply-chain (Actions)** | `uses:` pinned to full commit SHAs; `permissions: contents: read` and `persist-credentials: false` on CI; no `pull_request_target` + checkout; no `${{ github.event.* }}` in run steps (SEC-04). |
| **AI private enforcement** | The `CloudSafe<T>` brand forces AI-bound payloads through `assertCloudAllowed()` or `cloudSafe*()` constructors, with a live re-check from disk at every call site. |
| **Capture inbox traversal** | `inbox_file()` rejects names with path separators or leading dots. |
| **Capture envelope validation** | `captureEnvelopeSchema` validates `url` as `z.url().refine(isHttpUrl)`; the envelope parses with `safeParse`. |
| **GitHub OAuth token storage** | `secret_*` commands use only the OS keychain, under the `reflect-open` service. |
| **HTML meta scraping** | `parsePageMeta` uses `DOMParser` (no script execution); values capped at 500 chars. |
