## Summary

Implemented iOS/mobile parity for the desktop note privacy toggle by adding a lock/unlock action to the existing mobile note actions drawer and routing it through the canonical [`toggleNotePrivate`](../../apps/desktop/src/lib/note-private.ts) flow.

## Implementation

- Added the mobile privacy action in [`apps/desktop/src/mobile/note-actions-menu.tsx`](../../apps/desktop/src/mobile/note-actions-menu.tsx).
- Shared watcher-lag bridging and failure handling between desktop and mobile through [`apps/desktop/src/lib/notes/use-bridged-note-toggle.ts`](../../apps/desktop/src/lib/notes/use-bridged-note-toggle.ts), with desktop adoption in [`apps/desktop/src/components/context-sidebar/note-toggle-action.tsx`](../../apps/desktop/src/components/context-sidebar/note-toggle-action.tsx).
- Covered mobile lock/unlock behavior, stale-index bridging, failure rollback, loading-state gating, daily-note support, and pin/share/delete regressions in [`apps/desktop/src/mobile/note-actions-menu.test.tsx`](../../apps/desktop/src/mobile/note-actions-menu.test.tsx).

## Verification

- Focused tests:
  - `pnpm test --run apps/desktop/src/mobile/note-actions-menu.test.tsx`
  - `pnpm test --run apps/desktop/src/components/context-sidebar/note-actions-section.test.tsx`
- Repo checks:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm check`
- iOS simulator attempt:
  - Tried `pnpm tauri:ios:dev "iPhone 17 Pro"`.
  - Vite started, `ios-deploy` installed automatically, and `xcodebuild` launched against simulator `9C1FC0E2-BC1D-4477-9042-D7174EF9BB26`.
  - The simulator install/run did not complete within the observation window, so there is no confirmed on-device UI result from this run.

## Publishing

- Branch: `codex/ios-lock-note`
- PR: [#1125](https://github.com/team-reflect/reflect-open/pull/1125)
- Initial publish commit: `424c10a94bcc4406a9f607e6909717a8eafbbb51`
- CI on the initial publish reached all-green before the review follow-up in this worktree.

## Follow-up

- Addressed automated review feedback by:
  - gating the privacy action until the indexed note row is loaded, avoiding a misleading lock/unlock label while note state is unresolved
  - converting the worklog markdown links to repository-relative paths so they render correctly on GitHub
- No additional product-scope caveats were found beyond the incomplete simulator smoke run above.
