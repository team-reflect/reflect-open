# iOS Context List Cycle Final Report

## Implementation

- Added upstream Meowdown command `cyclePlainList` in prosekit/meowdown#396.
- Pinned Reflect to the Meowdown PR snapshot for commit `df741bb`.
- Changed Reflect's iOS formatting toolbar bullet/list button to call `editor.commands.cyclePlainList()`.
- Updated the button's accessibility label from `Bullet list` to `Cycle list style`.
- Kept the existing task icon on `cycleCheckableList()`, including its haptics and focus-preserving tap behavior.

## State Table

| Current editor state | Next state |
| --- | --- |
| Not a plain bullet or ordered list | Unordered list |
| Unordered list | Ordered list |
| Ordered list | No list |

Task items are treated as non-plain-list content on the first press. They convert to a plain unordered list item and Meowdown clears stale task attrs so checkbox state is not silently preserved after the task marker is removed.

Nested selections use Meowdown's existing closest-list convention, matching `cycleCheckableList`. Keyboard list shortcuts continue to use their existing `toggleList` bindings.

## Verification

Meowdown:

- `pnpm test --run packages/core/src/extensions/list.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- PR: prosekit/meowdown#396

Reflect:

- `pnpm --filter @reflect/desktop test --run src/editor/formatting-toolbar-bridge.test.tsx src/mobile/formatting-toolbar.test.tsx src/editor/formatting-toolbar-store.test.ts`
- `pnpm check`
- `pnpm --filter @reflect/desktop build`

## QA Limits

iOS simulator/device QA could not run on this host because `xcrun simctl list devices available` fails with `xcrun: error: unable to find utility "simctl", not a developer tool or in PATH`. No dev app for this worktree appeared to be running, so there was nothing to rebuild/restart.
