# Security Pass – Plan

Branch: `claude/security-pass-20260615`  
Date: 2026-06-15

> Finding IDs here predate the final numbering in [findings.md](findings.md).

---

## Threat Model

Reflect Open is a local-first Tauri 2 note app. Notes are markdown files on the user's disk; optional GitHub sync is the only persistent remote surface. AI is strictly BYOK.

**Realistic threat actors**

| Actor | Vector |
|---|---|
| Malicious synced note | Someone with write access to a shared git repo adds a note with a crafted markdown link or frontmatter payload |
| Supply-chain attacker | Compromised npm or Cargo dependency; malicious postinstall/prepare hooks |
| Malicious web page captured via the Chrome extension | Page injects content that is stored as a capture note |

**In-scope attacks with realistic impact**

1. **Script injection via `javascript:` links.** A note with `[click me](javascript:invoke('secret_get', ...))`, once clicked, runs JavaScript with full IPC access (file writes, keychain reads, AI key exfiltration). The missing CSP is the main enabler.
2. **Arbitrary URL opening via frontmatter.** A crafted `gist.url: file:///...` makes `openUrl()` open arbitrary paths when the sidebar shows the published-URL section.
3. **Supply chain.** A compromised action or package with a `postinstall` hook runs code during CI/dev setup.

**Out of scope:** server-side attacks (there is no Reflect server), physical access, compromise of the user's GitHub account.

---

## Findings Summary

| ID | Title | Severity | Exploitability |
|---|---|---|---|
| SEC-01 | No Content Security Policy (`csp: null`) | High | Moderate — requires a clicked link |
| SEC-02 | Gist URL not scheme-validated before `openUrl()` | Medium | Easy — frontmatter edit + sidebar visit |
| SEC-03 | GitHub OAuth `verificationUri` not scheme-validated | Low | Theoretical (trusted API) |
| INFO-01 | Devtools enabled in release builds (by design) | Info | — |

The surfaces found well protected are listed in [findings.md](findings.md).

---

## Fix Plan

### Priority 1 — Add Content Security Policy (SEC-01)

Set `"csp"` in `apps/desktop/src-tauri/tauri.conf.json`. `script-src 'self'` (no `'unsafe-inline'`) blocks `javascript:` href execution in WKWebView/WebView2/webkitgtk per the W3C spec, while IPC, the asset protocol, HTTP-plugin fetch and inline styles keep working:

```json
"csp": "default-src 'self' ipc: http://ipc.localhost; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: asset: https:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com https://openrouter.ai https://github.com https://api.github.com"
```

**Regression risk:** Low. Bundled JS is `'self'`, the HTTP plugin is capability-gated in Rust, and `'unsafe-inline'` styles stay for the editor.

### Priority 2 — Validate URL scheme before `openUrl()` (SEC-02)

In `published-url-section.tsx`, `github-auth-step.tsx`, and `gistFrontmatterSchema.url` (`packages/core/src/markdown/model.ts`), require `https://` (or `http://` for the device-flow URI) so `file://`, `app://` and other schemes never reach `openUrl()`.

**Regression risk:** Very low. Gist URLs are always `https://gist.github.com/...`; the device-flow URI is always `https://github.com/login/device`.

---

## Acceptance Criteria

- [ ] `tauri.conf.json` has a non-null CSP with `script-src 'self'`
- [ ] `published-url-section.tsx` validates URL scheme before calling `openUrl()`
- [ ] `gistFrontmatterSchema.url` rejects non-http(s) values
- [ ] `pnpm typecheck` and `pnpm lint` pass
- [ ] Tests for URL-validation logic pass
- [ ] Findings documented in `docs/security-pass/findings.md`

---

## Verification Approach

Typecheck, lint, and targeted tests for `packages/core/src/markdown/frontmatter` and `apps/desktop/src/components/context-sidebar`. A manual build smoke test was blocked (no Rust toolchain); CI runs it instead.
