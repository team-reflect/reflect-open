/**
 * What committing the inline editor should do with `current` vs the `initial` seed.
 */
export type TaskDraftResolution =
  | { type: 'commit'; content: string }
  | { type: 'cancel' }
  | { type: 'delete' }

/**
 * Decide the outcome of finishing an inline task edit (Plan 18). Whitespace-only
 * differences don't count, so re-selecting and tabbing away never rewrites the
 * file; clearing the content deletes the task (V1's empty-task behavior); any
 * other change commits the trimmed content.
 */
export function resolveTaskEdit(initial: string, current: string): TaskDraftResolution {
  const content = current.trim()
  if (content === initial.trim()) {
    return { type: 'cancel' }
  }
  if (content === '') {
    return { type: 'delete' }
  }
  return { type: 'commit', content }
}
