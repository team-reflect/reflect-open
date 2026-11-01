# Security Pass – Final Report

**Branch:** `claude/security-pass-20260615`  
**Base:** `origin/next` at `d4b21e30481d177117695b9a2fac7bec5df82e1d`  
**Commit:** `3b77ca9`  
**PR:** https://github.com/team-reflect/reflect-open/pull/232  
**Date:** 2026-06-15  

---

## What was audited

Seven parallel domain audits: supply chain (package scripts, lockfile, CI/CD),
Tauri capabilities and IPC boundaries, Rust native code (path traversal,
secrets, watcher, SQL), BYOK AI boundaries and `private: true`, markdown/HTML
rendering and links, database and query validation, secrets and config leakage.

---

## Fixes implemented

| ID | Severity | File(s) | Description |
|---|---|---|---|
| SEC-01 | High | `apps/desktop/src-tauri/tauri.conf.json` | Set restrictive CSP (`script-src 'self'`) — was `null` |
| SEC-03 | High | `packages/core/src/embeddings/retrieve.ts` | Exclude private notes from `relatedNotes()` KNN query |
| SEC-02 | Medium | `published-url-section.tsx`, `github-auth-step.tsx`, `packages/core/src/markdown/model.ts` | Validate URL scheme before `openUrl()`; gist URL schema requires http(s) |
| SEC-05 | Medium | `apps/desktop/package.json` | Move `shadcn` CLI to `devDependencies` |
| SEC-04 | Low | `.github/workflows/release.yml` | Pass `workflow_dispatch` flag via env var, not inline expression |
| SEC-06 | Low | `.gitignore` | Add `.env*` patterns |
| SEC-07 | Low | `apps/desktop/src/components/settings/github-auth-step.tsx` | Scheme guard on GitHub device-flow verification URI |

---

## Checks run

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ 0 errors |
| `pnpm lint` | ✅ 0 errors (4 pre-existing warnings, unchanged) |
| `packages/core/src/markdown/` tests | ✅ 25/25 |
| `packages/core/src/embeddings/` tests | ✅ 12/12 |
| Full markdown + embeddings suite | ✅ 285/285 |
| `published-url-section` component tests | ✅ 7/7 |

---

## Remaining risks

All are tracked in [findings.md](findings.md):

1. **Private note vectors in `embedding_chunks`** (D-01). SEC-03 hides them in
   the UI, but `backfillEmbeddings()` still indexes private notes.
2. **Keychain entry name enumeration** (D-04). Blocked by the CSP; a Rust
   allowlist is defence-in-depth.
3. **`spike_mobile.rs` in production** (D-09). Temporary mobile
   instrumentation (since removed).
4. **`capture_meta_fetch` SSRF** (D-03). Mitigated by size, redirect, timeout
   and content-type limits.
