import { renderInlineText } from '../markdown/index.ts'
import type { OpenTask } from '../tasks/open-task.ts'

/**
 * An open-task row with sensible defaults for tests; override only what a
 * case needs. `text` tracks `markdown` unless a case pins it explicitly.
 */
export function makeOpenTask(overrides: Partial<OpenTask> = {}): OpenTask {
  const markdown = overrides.markdown ?? overrides.text ?? 'do it'
  return {
    notePath: 'notes/n.md',
    astPath: [0],
    markdown,
    checked: false,
    text: renderInlineText(markdown),
    breadcrumbs: [],
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}
