# Quality pass — final report

- **PR:** https://github.com/team-reflect/reflect-open/pull/23
- **Branch:** `refactor/open-quality-pass-20260609-2228`
- **Base:** `origin/master` @ `4fe1dc859e6cb79c58244a8a0c1d5985d207df1a`
- **Diff:** 33 files changed, +1408 / −357 (before this report)

## Commits

| SHA | Subject |
|---|---|
| `9009b00` | docs: quality-pass plan — audit, targets, rejected refactors |
| `0fcb715` | refactor(desktop): extract wiki-link navigation hook and note-pane banners |
| `191b853` | refactor(desktop): split graph-workspace into one component per file |
| `6eb5692` | refactor(desktop): share one NoteLinkList between backlinks and related notes |
| `c20193b` | refactor(desktop): extract useFileChanges watcher-subscription hook |
| `93a4ee8` | refactor: dedupe error-message normalization via core errorMessage helper |
| `dda5502` | docs: contributor guides for commands, settings, and the editor |
| `fdcd238` | docs: quality-pass status — targets done, verification green |

(This report is committed after `fdcd238`.)

## Files by theme

**T1 — Note-pane decomposition**
- `apps/desktop/src/editor/use-wiki-link-navigation.ts` (+ `.test.tsx`, new)
- `apps/desktop/src/components/inline-alert.tsx` (new)
- `apps/desktop/src/components/note-conflict-banner.tsx` (new)
- `apps/desktop/src/components/protected-note-view.tsx` (new)
- `apps/desktop/src/components/note-pane.tsx` (now composition-only)

**T2 — graph-workspace split**
- `apps/desktop/src/components/workspace-header.tsx` (+ `.test.tsx`, new)
- `apps/desktop/src/components/cloud-sync-banner.tsx` (+ `.test.tsx`, new)
- `apps/desktop/src/components/search-route.tsx`, `route-content.tsx`,
  `workspace-content.tsx` (new)
- `apps/desktop/src/components/graph-workspace.tsx` (163 → 12 lines)

**T3 — Shared link list**
- `apps/desktop/src/components/note-link-list.tsx` (new)
- `apps/desktop/src/components/backlinks-panel.tsx`, `related-notes.tsx`
  (thin query adapters; existing tests pass unchanged)

**T4 — Watcher subscription hook**
- `apps/desktop/src/lib/use-file-changes.ts` (+ `.test.tsx`, new)
- `apps/desktop/src/editor/use-note-document.ts` (adopts the hook)

**T5 — Error-message dedup**
- `packages/core/src/errors.ts` (`errorMessage`), `errors.test.ts`, `index.ts`
- `apps/desktop/src/editor/note-session.ts`, `rename-coordinator.ts`,
  `use-image-persistence.ts`
- `apps/desktop/src/providers/graph-provider.tsx`, `settings-provider.tsx`

**T6 — Contributor docs**
- `docs/contributing/adding-a-command.md`, `adding-a-setting.md`,
  `editor-architecture.md` (new); `CONTRIBUTING.md` (links)

**Artifacts**
- `docs/open-quality-pass/plan.md`, `status.md`, `final-report.md`

## Verification (run at `dda5502`/`fdcd238`)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass — `Tasks: 3 successful, 3 total` |
| `pnpm lint` | pass — oxlint over `apps packages`, exit 0 |
| `pnpm test` | pass — 3/3 tasks; desktop suite: 35 files / 204 tests, all green |
| `pnpm build` | pass — Vite build OK; pre-existing >500 kB chunk warning only |

`pnpm install --frozen-lockfile` was not needed (dependencies already
installed); no Rust files were touched, so `cargo test` was not required.

## Tests added

- `use-wiki-link-navigation.test.tsx` — 6 (resolve→navigate, ISO date→daily,
  unresolved→create+open, null generation, empty target, unmount guard)
- `use-file-changes.test.tsx` — 5 (delivery, drop-after-teardown, late-unlisten
  close, resubscribe on handler change, disabled/no-bridge)
- `workspace-header.test.tsx` — 4; `cloud-sync-banner.test.tsx` — 2
- `errors.test.ts` — 2 new `errorMessage` cases

## Plan deviations

- **T4:** `useFileChanges` adopted in `use-note-document.ts` only.
  `embeddings-sync.tsx` keeps its inline subscription — it shares one `active`
  flag between subscription teardown and the work queue's staleness epoch, and
  splitting that would require new epoch machinery (more code, not less).

## Remaining recommendations (out of scope, see plan.md "Rejected")

1. **Code-split the 1.2 MB bundle chunk** — the Vite warning predates this
   branch; `manualChunks` for meowdown/ProseMirror and the ONNX runtime would
   be the natural cut.
2. **Promote `InlineAlert` to the design-system package** once that package
   exports components at all (today it ships only CSS/tokens/assets) — a
   package-level decision, not a refactor.
3. **Settings radio-group extraction** when a second enum-valued setting
   lands; one consumer doesn't justify the abstraction yet.
4. **`queries.ts` split** by domain if it keeps growing; current size doesn't
   warrant it.
5. **Embeddings-sync epoch refactor** if a third watcher consumer appears —
   that would justify generalizing `useFileChanges` with an epoch/staleness
   parameter.
