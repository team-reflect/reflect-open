## Goal

Expose the desktop note privacy toggle on iOS/mobile by adding a Lock/Unlock action to the existing note actions drawer, while keeping privacy semantics anchored to the canonical `private: true` frontmatter flag and the existing `toggleNotePrivate(path, generation)` flow.

## Verified context

- Desktop note actions already toggle privacy through [`apps/desktop/src/components/context-sidebar/note-actions-section.tsx`](../../apps/desktop/src/components/context-sidebar/note-actions-section.tsx) and [`apps/desktop/src/components/context-sidebar/note-toggle-action.tsx`](../../apps/desktop/src/components/context-sidebar/note-toggle-action.tsx).
- The canonical write path is [`apps/desktop/src/lib/note-private.ts`](../../apps/desktop/src/lib/note-private.ts), which flips `private: true` in note frontmatter via the shared note frontmatter write channel.
- Mobile note actions currently live in [`apps/desktop/src/mobile/note-actions-menu.tsx`](../../apps/desktop/src/mobile/note-actions-menu.tsx) and only expose pin/share/delete.
- Indexed note privacy is exposed through [`apps/desktop/src/hooks/use-note-row.ts`](../../apps/desktop/src/hooks/use-note-row.ts).
- Mobile failures from background work are surfaced through the operations store and pills in [`apps/desktop/src/mobile/operations-pill.tsx`](../../apps/desktop/src/mobile/operations-pill.tsx).
- AI/privacy enforcement still hinges on the same canonical flag via [`packages/core/src/ai/checkers.ts`](../../packages/core/src/ai/checkers.ts) and the live frontmatter read paths already used by AI/gist features.

## Implementation plan

1. Extract the desktop toggle bridge into a shared hook.
   - Move the pending-toggle reconciliation logic out of `NoteToggleAction`.
   - Keep the existing contracts: indexed state is the base truth, the toggle result bridges watcher/index lag, double taps are blocked while a write is in flight, and failures report through `startOperation(...).fail(...)`.
   - Support both static failure labels (desktop’s current “Updating privacy”) and action-specific labels needed by mobile (“Locking note” / “Unlocking note”).

2. Wire the mobile drawer to indexed privacy state and the canonical toggle.
   - Read the current note row with `useNoteRow(path)`.
   - Gate the privacy action until the row is loaded, then derive `Lock note` vs `Unlock note` from the indexed `isPrivate` flag, bridged by the shared hook while mobile’s local write echo and index catch up.
   - Call `toggleNotePrivate(path, graph.generation)` through the shared hook; do not add a second privacy write path.
   - Use lock/unlock icons with visible text labels so the control remains accessible by name.

3. Preserve drawer semantics and retryability.
   - Close the note actions drawer immediately when the privacy action is tapped, matching the current pin/share behavior.
   - If the write fails, clear the optimistic bridge, surface the failure through mobile operations status, and leave the user able to reopen the drawer and retry.
   - Prevent rapid repeat taps from racing two toggles by disabling the row while the write is in flight.

4. Keep scope focused.
   - Do not change the meaning of `private: true`.
   - Do not add encryption/device-auth framing.
   - Do not alter unrelated AI/privacy enforcement beyond confirming this UI drives the same frontmatter flag those features already honor.

## Test strategy

- Extend [`apps/desktop/src/mobile/note-actions-menu.test.tsx`](../../apps/desktop/src/mobile/note-actions-menu.test.tsx) to cover:
  - `Lock note` for public notes.
  - `Unlock note` for private notes.
  - The canonical toggle receiving `path` and current `generation`.
  - Result bridging while indexed state is stale.
  - Failure rollback plus surfaced operation failure.
  - Drawer close behavior after tapping the privacy action.
  - Daily-note coverage.
  - Regression coverage that pin/share/delete still render and behave.
- Keep the existing desktop note-actions tests passing to verify the shared hook did not regress desktop behavior.
- Run focused Vitest tests for the changed files, then `pnpm typecheck`, `pnpm lint`, and `pnpm check`.
- Attempt an iOS simulator smoke check if the environment is ready enough to make it practical.
