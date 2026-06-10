# Open quality pass — plan

Branch: `refactor/open-quality-pass-20260609-2228` · Base: `origin/master` @ `4fe1dc8`

## Architecture observations

The repo is a pnpm/Turborepo monorepo (`apps/desktop`, `packages/core`,
`packages/db`, `design-system`) with one load-bearing rule that is genuinely
held to: TypeScript owns policy, Rust owns capabilities, and `@reflect/core`
never imports Tauri (bridge injection keeps it vitest-testable). Most modules
are already small, documented, and tested — `note-session.ts` is a pure state
machine with a React adapter, the command registry is explicit, the router is
a typed in-memory history stack. This is *not* a codebase that needs a rewrite.

What an honest "if we started again" critique still finds:

1. **`note-pane.tsx` braids four concerns and is untested.** Document binding,
   wiki-link resolution/navigation/creation (real domain behavior: resolved →
   navigate, ISO date → daily route, unresolved → create-and-open, unmount
   guard), three hand-rolled alert banners, and editor wiring all live in one
   224-line component with no test file. The wiki-link behavior is only
   "documented" by a comment.
2. **One-component-per-file is violated exactly where contributors will look
   first.** `graph-workspace.tsx` holds four components (workspace, content,
   search route, route switch) — the routing/view boundary is real but
   invisible. The header is also hook-coupled, so it can't be rendered in a
   test without faking five providers.
3. **Near-identical components.** `BacklinksPanel` and `RelatedNotes` are the
   same section/list/button rendering with different queries. The amber/red
   inline alert styling is hand-copied 5× across `note-pane.tsx` and
   `graph-workspace.tsx`.
4. **Duplicated fiddly plumbing.** The watcher subscription dance (active
   flag, late-resolving unlisten) appears in `use-note-document.ts` and
   `embeddings-sync.tsx`; `messageOf(error)` is re-implemented in
   `note-session.ts`, `rename-coordinator.ts`, and `graph-provider.tsx`, two
   of which re-derive what `toAppError().message` already guarantees.
5. **Contributor docs stop at conventions.** CONTRIBUTING/AGENTS say *where*
   code goes, but there is no task-oriented guide for the three things a new
   contributor most likely wants to do: add a command, add a setting, or
   touch the editor stack (session ← hook ← pane layering, roundtrip
   protection, frontmatter ownership).

## Refactor targets (chosen)

### T1 — Note pane decomposition + tests
- Extract `use-wiki-link-navigation.ts` (hook owning resolve → navigate /
  daily / create, with the unmount guard) + tests for all four behaviors.
- Extract `inline-alert.tsx` (tone: `warning` | `error`) and reuse it for the
  save-error, image-error, conflict, protected, and cloud-sync banners.
- Extract `note-conflict-banner.tsx` (Keep mine / Load theirs) and
  `protected-note-view.tsx`; `note-pane.tsx` becomes composition.

### T2 — Workspace/routing boundary
- Split `graph-workspace.tsx` into `workspace-header.tsx` (props-driven,
  testable without providers), `cloud-sync-banner.tsx` (owns the cloud-label
  map), `route-content.tsx`, and `search-route.tsx`.
- Add tests for the header and the cloud banner labels.

### T3 — Shared note-link list
- Extract `note-link-list.tsx` (section + title/snippet button list);
  `BacklinksPanel` and `RelatedNotes` become thin query adapters. Existing
  tests must keep passing unchanged — that is the behavior-preservation proof.

### T4 — Watcher subscription hook
- Extract `use-file-changes.ts` reproducing today's exact lifecycle semantics
  (resubscribe on handler identity change, drop events after teardown, close
  a late-resolving unlisten). Adopt in `use-note-document.ts` and
  `embeddings-sync.tsx`. Test the lifecycle directly.

### T5 — Error-message dedup
- Add `errorMessage(value: unknown): string` to `@reflect/core` errors (thin
  wrapper over `toAppError`), replace the three local `messageOf` copies and
  inline `toAppError(x).message` call sites. Check note-session tests for
  message-shape assertions before changing.

### T6 — Contributor guides
- `docs/contributing/adding-a-command.md`, `adding-a-setting.md`,
  `editor-architecture.md`; link from `CONTRIBUTING.md`.

## Rejected (deliberately)

- **Splitting `note-session.ts` (489 lines).** It is one state machine whose
  invariants (save chain, echo detection, conflict gating) are co-located on
  purpose and covered by a 261-line test file. Splitting scatters invariants.
- **Extracting graph-provider's open-sequencing into a standalone machine.**
  Real subtlety, but already covered by `graph-provider.test.tsx`; the
  rewrite risk outweighs the testability gain in this pass.
- **Moving `InlineAlert` into `design-system/`.** The package currently
  exports only CSS/tokens/assets, no React entry point; adding one is a
  bigger decision than this pass should smuggle in. App-level component now,
  promotion noted as follow-up.
- **Generic radio-card group for settings.** One setting exists; premature.
- **Splitting `packages/core/indexing/queries.ts` (265 lines).** A cohesive,
  flat collection of query functions; splitting is churn.
- **Any palette restructure.** Already well-factored (provider / results hook
  / entries / registry, each tested).

## Acceptance criteria

- No behavior or public-API changes; existing tests pass unmodified (except
  imports if a symbol moves).
- Every extracted module has a doc comment and direct tests (T1, T2, T4, T5).
- `note-pane.tsx` and `graph-workspace.tsx` each contain exactly one
  component.
- New contributor guides accurately reflect the code as it is on this branch.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` pass.

## Verification plan

1. `pnpm install --frozen-lockfile` (worktree has no `node_modules`).
2. `pnpm typecheck && pnpm lint && pnpm test` after each theme; full
   `pnpm build` at the end.
3. Grep-verify no orphaned imports/exports after moves.

## Risks / caveats

- `embeddings-sync.tsx` adoption of `use-file-changes` must preserve the
  queue's cross-graph persistence and the at-event-time staleness checks;
  mitigated by keeping resubscribe-on-deps semantics identical.
- `errorMessage` swap slightly changes non-Error object rendering in
  note-session (`String(obj)` → JSON) — strictly better, but check test
  assertions.
- `pnpm build` runs Vite + tsc only (no Tauri bundle); Rust is untouched, so
  `cargo test` is out of scope and will be noted, not claimed.
- jsdom tests can't validate real editor focus/scroll behavior; UI changes
  here are markup-preserving extractions to minimize that exposure.
