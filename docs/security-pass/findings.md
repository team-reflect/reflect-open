# Security Pass – Findings

Branch: `claude/security-pass-20260615`  
Reviewer: Claude (claude-sonnet-4-6)  
Date: 2026-06-15

---

## Fixed in this pass

### SEC-01 · No Content Security Policy · **High** · Fixed

**Location:** `apps/desktop/src-tauri/tauri.conf.json` line 24  
**Severity:** High | **Exploitability:** Moderate (requires clicking a crafted link)

`"csp": null` left the Tauri WebView with no Content-Security-Policy header, making the app
vulnerable to `javascript:` URI execution. In Tauri 2, clicking an `<a href="javascript:...">` link
rendered by the meowdown/ProseMirror markdown editor evaluates the JavaScript in the app's WebView
context — which has full access to the Tauri IPC bridge. An attacker who can write to a synced note
(e.g., a shared git repository) could craft a link that calls `invoke('secret_get', ...)` to extract
BYOK API keys, or calls `invoke('note_write', ...)` to overwrite arbitrary notes.

**Fix:** Set `"csp"` to a restrictive policy in `tauri.conf.json`:
- `script-src 'self'` blocks `javascript:` URI execution (W3C spec: CSP applies to `javascript:` navigation)
- `style-src 'self' 'unsafe-inline'` allows ProseMirror/meowdown's inline styles
- `img-src 'self' blob: data: asset: https:` allows graph images via the asset protocol
- `connect-src` restricted to Tauri IPC and the AI/GitHub endpoints already gated by the HTTP capability

---

### SEC-02 · Gist URL scheme not validated before `openUrl()` · **Medium** · Fixed

**Location:** `apps/desktop/src/components/context-sidebar/published-url-section.tsx` line 65  
**Severity:** Medium | **Exploitability:** Easy (frontmatter edit + open sidebar)

The `gistUrl` field from note frontmatter was passed directly to `openUrl()` without scheme
validation. A crafted frontmatter entry (`gist: {url: "file:///etc/passwd", ...}`) would cause
`openUrl()` to open an arbitrary path using the OS's default file handler when the user viewed
the note's context sidebar. The `gistFrontmatterSchema` also accepted any string for `url`.

**Fix (two layers):**
1. `gistFrontmatterSchema.url` now validates `http(s)://` prefix — invalid URLs cause the whole
   gist block to degrade to `undefined` (the existing `.catch(undefined)` pattern).
2. `openPublishedUrl` in `published-url-section.tsx` guards with `url.startsWith('https://')`.

Tests added: "rejects a non-http(s) gist url, degrading to 'never published'" in
`packages/core/src/markdown/frontmatter.test.ts`.

---

### SEC-03 · Private notes surface in "Similar Notes" sidebar · **High** · Fixed

**Location:** `packages/core/src/embeddings/retrieve.ts` line 244–252  
**Severity:** High | **Exploitability:** Easy (automatic, no click required)

`relatedNotes()` seeded the KNN neighbor search from the current note's stored chunk vectors and
returned all neighbor notes — including those with `private: true` in their frontmatter. The
"Similar notes" sidebar rendered every `RetrievalHit`, so a private note's title was visible
whenever it was semantically similar to the note currently open. No note content was shown, but
the title itself can be sensitive.

**Fix:** Added `AND n.is_private = 0` to the KNN neighbor query inside `relatedNotes()` so private
notes never appear as semantic neighbors in the sidebar.

---

### SEC-04 · GitHub Actions: workflow_dispatch input interpolated into shell · **Low** · Fixed

**Location:** `.github/workflows/release.yml` line 125  
**Severity:** Low | **Exploitability:** Theoretical (input is typed boolean)

The `${{ inputs.draft && '--draft' || '' }}` expression was interpolated directly into the `run:`
shell command string rather than being passed through an environment variable. While the `draft`
input is declared `type: boolean` (limiting GitHub-validated values to `true`/`false`), direct
`${{ }}` interpolation in run steps is the pattern that leads to injection if the input type or
source ever changes.

**Fix:** The flag is now set as `DRAFT_FLAG: ${{ inputs.draft && '--draft' || '' }}` in the step's
`env:` block and referenced as `$DRAFT_FLAG` in the run command.

---

### SEC-05 · `shadcn` CLI in `dependencies` pulls network-capable dev tooling into prod closure · **Medium** · Fixed

**Location:** `apps/desktop/package.json` line 48  
**Severity:** Medium | **Exploitability:** Low (no runtime exposure in the Tauri app)

`shadcn@4.11.0` is a code-generation CLI that is only needed at development time. Placing it under
`dependencies` instead of `devDependencies` caused `@dotenvx/dotenvx` (a `.env` file processor
with a shell binary) and `@modelcontextprotocol/sdk` (1.29.0 — an MCP network client) to appear in
the production dependency closure. Neither is used at runtime in the Tauri app.

**Fix:** Moved `shadcn` from `dependencies` to `devDependencies`.

---

### SEC-06 · `.gitignore` missing `.env` pattern · **Low** · Fixed

**Location:** `.gitignore`  
**Severity:** Low | **Exploitability:** Easy (accidental commit)

No `.env` entries existed in `.gitignore`, leaving `.env`, `.env.local`, and similar files free
to be committed accidentally.

**Fix:** Added `.env`, `.env.*`, and `!.env.example` to `.gitignore`.

---

### SEC-07 · GitHub auth step: `verificationUri` not scheme-validated before `openUrl()` · **Low** · Fixed

**Location:** `apps/desktop/src/components/settings/github-auth-step.tsx` line 114  
**Severity:** Low | **Exploitability:** Theoretical (MitM on GitHub API required)

`flow.verificationUri` from GitHub's device-flow API was passed directly to `openUrl()`. In
practice the HTTP capability allows only `https://github.com/...` calls, so a non-https value
could only arrive via a compromised GitHub API or MitM.

**Fix:** Added `startsWith('https://')` guard before `openUrl()` call, consistent with SEC-02's
defence-in-depth pattern.

---

## Deferred recommendations

| ID | Finding | Reason for deferral |
|---|---|---|
| D-01 | Private notes indexed into `embedding_chunks` / `embedding_vectors` | Fixing `backfillEmbeddings()` also requires retroactive deletion of existing private-note vectors and a transition when `private:` is toggled. Substantial scope; the SEC-03 fix blocks the UI exposure. |
| D-02 | Devtools feature compiled into release builds | Intentional design choice (see `src/devtools.rs` comment). Low marginal risk given the CSP fix. |
| D-03 | `capture_meta_fetch` can reach internal network endpoints | Mitigated by 512 KB cap, 5-redirect limit, 15 s timeout, and html-only content-type check. True SSRF would require an attacker-controlled capture URL; the capture envelope's `z.url().refine(isHttpUrl)` already rejects non-http(s). |
| D-04 | `secret_set`/`secret_get` accept unconstrained keychain entry names | Requires a compromised WebView to call; blocked by the CSP fix. Adding a static allowlist of valid key names is good defence-in-depth but is a larger Rust+TS change. |
| D-05 | `graph_open`/`graph_create` accept arbitrary absolute paths | By design — the user picks the graph folder. No path traversal within a graph is possible (`resolve.rs`). |
| D-06 | `HF_ENDPOINT` env var can redirect model download | Could be gated behind `#[cfg(debug_assertions)]`. Low exploitability; requires setting a process environment variable. |
| D-07 | `prebuild-install` (transitive dep of `better-sqlite3`) deprecated | Mitigation: track `better-sqlite3` releases for migration to a maintained alternative. |
| D-08 | Release workflow credential exposure during `pnpm install` | Splitting build/publish jobs would eliminate credential exposure at install time. Good practice but non-trivial workflow restructuring. |
| D-09 | `spike_mobile.rs` instrumentation in production mobile binary | Marked `TEMPORARY` in the code; should be removed when Plan 19 spike concludes. |

---

## Surfaces confirmed safe (no action needed)

| Surface | Evidence |
|---|---|
| **Path traversal** | `resolve.rs`: two-layer guard — lexical (rejects `..`, absolute paths) + canonical symlink check. Unit-tested including symlink escape case. |
| **SQL injection** | All IPC-facing queries use parameterized Kysely/rusqlite. `db_query` read bridge additionally blocks `ATTACH`/`DETACH`/`PRAGMA` via SQLite authorizer. |
| **Supply-chain (Actions)** | All `uses:` lines pinned to full 40-hex-char commit SHAs. `permissions: contents: read` on CI. `persist-credentials: false` on CI checkout. No `pull_request_target` + checkout combination. No `${{ github.event.* }}` interpolation into run steps (fixed in SEC-04). |
| **AI private enforcement** | `CloudSafe<T>` brand type forces every AI-bound payload through `assertCloudAllowed()` or `cloudSafe*()` constructors. TOCTOU live re-check from disk at every call site. |
| **Capture inbox traversal** | `inbox_file()` rejects filenames with path separators or leading dots. |
| **Capture envelope validation** | `captureEnvelopeSchema` validates `url` as `z.url().refine(isHttpUrl)`. |
| **GitHub OAuth token storage** | `secret_*` IPC commands store/retrieve only from the OS keychain under the `reflect-open` service. |
| **HTML meta scraping** | `parsePageMeta` uses `DOMParser` (no script execution); scraped values capped at 500 chars before storage. |
