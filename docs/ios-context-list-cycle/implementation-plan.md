# iOS Context List Cycle Implementation Plan

## Goal

Change the Reflect iOS editor context bar bullet-list button so it cycles the active block or selection through:

| Current editor state | Next state |
| --- | --- |
| Not a plain bullet or ordered list | Unordered list |
| Unordered list | Ordered list |
| Ordered list | No list |

The behavior must use editor transactions, not Markdown text insertion, so it preserves selection, undo grouping, nesting, marker serialization, empty list items, and multi-line selections.

## Traced Surfaces

- Reflect iOS toolbar UI: `apps/desktop/src/mobile/formatting-toolbar.tsx`
- Reflect toolbar command bridge: `apps/desktop/src/editor/formatting-toolbar-bridge.tsx`
- Reflect toolbar store/tests: `apps/desktop/src/editor/formatting-toolbar-store.ts`, `apps/desktop/src/editor/formatting-toolbar-bridge.test.tsx`, `apps/desktop/src/mobile/formatting-toolbar.test.tsx`
- Meowdown list commands/keymaps/tests: `packages/core/src/extensions/list.ts`, `packages/core/src/extensions/list.test.ts`
- Existing task toggle pattern: Meowdown `cycleCheckableList`, `rotateSquareTask`, `rotateCircleTask`; Reflect iOS task icon calls `editor.commands.cycleCheckableList()`

## Design

Add a canonical Meowdown command named `cyclePlainList` next to the existing task cycle commands.

The command will:

- Inspect the closest enclosing `list` node at the selection, matching the existing `getListAttrsAtSelection` convention.
- Treat only `kind: 'bullet'` and `kind: 'ordered'` as participating states.
- Use ProseKit `toggleList`/`wrapInList` primitives for the actual transaction.
- Convert bullet to ordered in place with preserved nesting/content.
- Unwrap ordered list items to text using the same behavior as existing keyboard `Mod-Shift-7`.
- Convert task and other list-like blocks to a plain unordered list rather than stripping task semantics through a two-step cycle. This matches the table's "anything else -> unordered list" rule and avoids deleting task state on the first press.

Reflect will then wire `FormattingToolbarCommands.toggleBulletList` to `editor.commands.cyclePlainList()` while keeping the public toolbar command name stable for a small reviewable diff. The task icon remains on `cycleCheckableList()`.

## Edge Cases To Test

- Paragraph: first press creates `- item`.
- Bullet: next press converts to `1. item`.
- Ordered: next press unwraps to `item`.
- Task: first press converts to plain bullet without silently preserving stale `checked` attrs as task semantics.
- Nested list: only the closest selected list item changes, matching `cycleCheckableList`.
- Keyboard commands: existing `Mod-Shift-7`, `Mod-Shift-8`, and task keymaps keep their current behavior.
- Reflect bridge: bullet toolbar command calls `cyclePlainList`; task toolbar command still calls `cycleCheckableList`.
- Reflect mobile toolbar: labels, focus behavior, and button dispatch remain unchanged.

## Verification Plan

Meowdown:

- `pnpm test --run packages/core/src/extensions/list.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build` if practical after focused checks pass

Reflect:

- `pnpm test --run apps/desktop/src/editor/formatting-toolbar-bridge.test.tsx apps/desktop/src/mobile/formatting-toolbar.test.tsx apps/desktop/src/editor/formatting-toolbar-store.test.ts`
- `pnpm check`
- Scoped build if practical: `pnpm --filter @reflect/desktop build`
- iOS QA: attempt simulator QA via the documented iOS flow if the host has an available simulator and dependencies; otherwise document the exact blocker.

## PR Plan

1. Commit, push, and open a ready Meowdown PR against `master` if `cyclePlainList` is added upstream.
2. Wire Reflect to the new command in the dedicated Reflect worktree.
3. Commit, push, and open a ready Reflect PR against `next`, clearly marking the Meowdown dependency and linking the upstream PR.
