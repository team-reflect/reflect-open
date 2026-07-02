# Security Pass – Plan

Branch: `claude/security-pass-20260615`  
Date: 2026-06-15

---

## Threat Model

Reflect Open is a local-first, open-source Tauri 2 note-taking app.  Notes are plain markdown files stored on the user's filesystem; the optional GitHub sync backend is the only persistent remote surface. The AI layer is strictly BYOK — no Reflect infrastructure.

**Realistic threat actors**

| Actor | Vector |
|---|---|
| Malicious synced note | Attacker with write access to a shared git repo inserts a note with a crafted markdown link or frontmatter payload |
| Supply-chain attacker | Compromised npm or Cargo dependency; malicious postinstall/prepare hooks |
| Malicious web page captured via the Chrome extension | Page injects content that gets stored as a capture note |

**In-scope attacks with realistic impact**

1. **Script injection via `javascript:` markdown links** — A note containing `[click me](javascript:invoke('secret_get', ...))` can, if clicked by the victim in the Tauri WebView, execute arbitrary JavaScript with full access to the Tauri IPC bridge (file writes, keychain reads, AI key exfiltration). The missing CSP is the primary enabler.

2. **Arbitrary URL opening via frontmatter** — A crafted `gist.url: file:///...` value in note frontmatter causes `openUrl()` to open arbitrary file system paths on the victim's machine when the sidebar shows the published-URL section.

3. **Supply-chain** — The GitHub Actions workflows and pnpm lockfile form the build surface. A compromised action or package with a `postinstall` hook runs arbitrary code during CI/dev setup.

**Out of scope (not realistic)**

- Server-side attacks (there is no Reflect server)
- Physical device access
- Compromise of the user's GitHub account itself

---

## Findings Summary

| ID | Title | Severity | Exploitability |
|---|---|---|---|
| SEC-01 | No Content Security Policy (`csp: null`) | High | Moderate — requires a clicked link |
| SEC-02 | Gist URL not scheme-validated before `openUrl()` | Medium | Easy — frontmatter edit + sidebar visit |
| SEC-03 | GitHub OAuth `verificationUri` not scheme-validated | Low | Theoretical (trusted API) |
| INFO-01 | Devtools enabled in release builds (by design) | Info | — |

**Well-protected surfaces (no action needed)**

- Path traversal: `resolve.rs` two-layer guard (lexical + canonical symlink check), unit-tested
- SQL injection: parameterized queries via Kysely + rusqlite; read-only bridge (`db_query`) blocks ATTACH/DETACH/PRAGMA via authorizer
- Supply chain: all GitHub Actions pinned to SHA hashes; `persist-credentials: false` on CI; `contents: read` least-privilege
- AI private enforcement: `CloudSafe<T>` brand type ensures checked-for-privacy payloads; TOCTOU live re-check at every call site
- Capture inbox: `inbox_file()` rejects path-separator or dotfile spool names
- Capture envelope: `url` field validated as http(s) URL via Zod; envelope schema parses with `safeParse`

---

## Fix Plan

### Priority 1 — Add Content Security Policy (SEC-01)

**File:** `apps/desktop/src-tauri/tauri.conf.json`  
**Change:** Set `"csp"` to a restrictive policy.

`script-src 'self'` (without `'unsafe-inline'`) blocks `javascript:` href execution in WKWebView/WebView2/webkitgtk per the W3C spec. The IPC, asset protocol, external fetch (via the HTTP plugin), and inline styles are all allowed.

```json
"csp": "default-src 'self' ipc: http://ipc.localhost; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: asset: https:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com https://openrouter.ai https://github.com https://api.github.com"
```

**Regression risk:** Low. The app's bundled JS is served from `'self'`; the HTTP plugin's fetch is already capability-gated at the Rust level; inline styles (`'unsafe-inline'` in `style-src`) are preserved for ProseMirror/meowdown.

### Priority 2 — Validate URL scheme before `openUrl()` (SEC-02)

**Files:**
- `apps/desktop/src/components/context-sidebar/published-url-section.tsx`
- `apps/desktop/src/components/settings/github-auth-step.tsx`
- `packages/core/src/markdown/model.ts` — add HTTPS-only refinement to `gistFrontmatterSchema.url`

Enforce `https://` (or `http://` for the GitHub device flow URI) at the call site and at the schema level, so `file://`, `app://`, and other dangerous schemes are rejected before hitting `openUrl()`.

**Regression risk:** Very low. Gist URLs are always `https://gist.github.com/...`; GitHub device-flow URIs are always `https://github.com/login/device`.

---

## Acceptance Criteria

- [ ] `tauri.conf.json` has a non-null CSP with `script-src 'self'`
- [ ] `published-url-section.tsx` validates URL scheme before calling `openUrl()`
- [ ] `gistFrontmatterSchema.url` rejects non-http(s) values
- [ ] `pnpm typecheck` passes with no errors
- [ ] `pnpm lint` passes with no errors
- [ ] Tests for URL-validation logic pass
- [ ] Findings documented in `docs/security-pass/findings.md`

---

## Verification Approach

1. `pnpm typecheck` — catches type regressions in the changed files
2. `pnpm lint` — catches lint violations
3. `pnpm test --run packages/core/src/markdown/frontmatter` — validates schema changes
4. `pnpm test --run apps/desktop/src/components/context-sidebar` — validates URL-guard tests
5. Manual smoke-test: build and verify that the app still loads (blocked by no Rust toolchain; CI will run instead)
