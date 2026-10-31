/**
 * Bring the row carrying `key` into view (V1 scrolls the selection on every
 * keyboard move). `block: 'nearest'` mirrors V1 — no jump when it's already
 * visible. A no-op when the row isn't mounted or `root` is gone.
 */
export function scrollTaskIntoView(root: HTMLElement | null, key: string): void {
  const selector = `[data-task-key="${key.replaceAll('"', String.raw`\"`)}"]`
  root?.querySelector(selector)?.scrollIntoView({ block: 'nearest' })
}
