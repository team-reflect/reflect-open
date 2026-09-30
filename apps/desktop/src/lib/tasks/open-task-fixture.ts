import { indexedTaskKey, inlineMarkdownToDisplayText, type Task } from '@reflect/core'

/** An indexed task with defaults for UI tests. */
export function makeOpenTask(overrides: Partial<Task> = {}): Task {
  const text = overrides.text ?? overrides.displayText ?? 'do it'
  const checked = overrides.checked ?? false
  const notePath = overrides.notePath ?? 'notes/n.md'
  const astPath = overrides.astPath ?? [0]
  return {
    key: indexedTaskKey(notePath, astPath),
    text,
    notePath,
    astPath,
    checked,
    displayText: inlineMarkdownToDisplayText(text),
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
