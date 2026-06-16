# Security Pass – Final Report

**Branch:** `claude/security-pass-20260615`  
**Base:** `origin/next` at `d4b21e30481d177117695b9a2fac7bec5df82e1d`  
**Commit:** `3b77ca9`  
**PR:** https://github.com/team-reflect/reflect-open/pull/232  
**Date:** 2026-06-15  

---

## What was audited

Seven parallel domain audits covering:
- Supply chain (package scripts, lockfile, CI/CD workflows)
- Tauri capabilities and IPC command boundaries
- Rust native code (path traversal, secrets, watcher, SQL)
- BYOK AI boundaries and `private: true` enforcement
- Markdown/HTML rendering and link handling
- Database and query validation
- Secrets handling and config leakage

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

1. **Private note content in `embedding_chunks`** — `backfillEmbeddings()` indexes private notes.
   The SEC-03 fix ensures they don't surface in the UI, but the vectors exist in SQLite. A
   comprehensive fix requires retroactive deletion when `private:` is set and re-indexing when
   unset. Tracked in `findings.md` D-01.

2. **Keychain entry name enumeration** — `secret_get` accepts arbitrary names. Blocked by the CSP
   fix; an allowlist in Rust is defence-in-depth. Tracked in `findings.md` D-04.

3. **`spike_mobile.rs` in production** — Development instrumentation in the mobile binary.
   Marked `TEMPORARY` in the code; remove when Plan 19 spike concludes. Tracked in `findings.md`
   D-09.

4. **`capture_meta_fetch` SSRF** — The bounded Rust HTTP fetch can reach any http(s) URL, including
   internal hosts. Mitigated by the 512 KB cap, 5-redirect limit, 15 s timeout, and Content-Type
   HTML-only check. Tracked in `findings.md` D-03.

---

## PR URL

https://github.com/team-reflect/reflect-open/pull/232
