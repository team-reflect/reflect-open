# Quality pass — status

Branch: `refactor/open-quality-pass-20260609-2228` (base: `origin/master` @ `4fe1dc8`)
Last updated: 2026-06-09

## Targets (from [plan.md](plan.md))

| Target | Status | Commit |
|---|---|---|
| Plan & architecture audit | done | `9009b00` |
| T1 — Note-pane decomposition (wiki-link hook, InlineAlert, banners) | done | `0fcb715` |
| T2 — graph-workspace split (header, cloud banner, route content) | done | `191b853` |
| T3 — Shared NoteLinkList for backlinks/related | done | `6eb5692` |
| T4 — useFileChanges subscription hook | done (scope note below) | `c20193b` |
| T5 — `errorMessage` in core, dedupe `messageOf` | done | `93a4ee8` |
| T6 — Contributor guides + CONTRIBUTING.md links | done | `dda5502` |

## Deviations from plan

- **T4 (partial adoption).** The plan proposed adopting `useFileChanges` in
  both `use-note-document.ts` and `embeddings-sync.tsx`. Only the former was
  converted: embeddings-sync's subscription is entangled with its work queue's
  staleness epoch (one `active` flag covers backfill staleness *and* queued
  watcher items), so forcing the shared hook there would have required adding
  an epoch mechanism — more code, not less. Rationale recorded in the T4
  commit message.

## Verification (run at HEAD = `dda5502`)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass — 3/3 tasks |
| `pnpm lint` | pass — oxlint, exit 0 |
| `pnpm test` | pass — 3/3 tasks; desktop: 35 files / 204 tests |
| `pnpm build` | pass — pre-existing >500 kB chunk warning only |

No Rust files were touched, so `cargo test` was not required.

## Remaining

- Write `final-report.md` (needs PR URL)
- Push branch, open PR against `master`
