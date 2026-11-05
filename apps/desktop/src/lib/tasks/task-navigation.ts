import type { VirtualizerHandle } from 'virtua'

/**
 * Bring the row carrying `key` into view (V1 scrolls the selection on every
 * keyboard move). `block: 'nearest'` mirrors V1 — no jump when it's already
 * visible. A no-op when the row isn't mounted or `root` is gone.
 */
export function scrollTaskIntoView(root: HTMLElement | null, key: string): void {
  const selector = `[data-task-key="${key.replaceAll('"', String.raw`\"`)}"]`
  root?.querySelector(selector)?.scrollIntoView({ block: 'nearest' })
}

/**
 * Bring item `index` of a virtualized Tasks list into view, below the stuck
 * group header of `headerHeight` px. No scroll when it is already visible.
 */
export function scrollTaskIndexIntoView(
  handle: VirtualizerHandle,
  index: number,
  headerHeight: number,
): void {
  const top = handle.getItemOffset(index)
  const bottom = top + handle.getItemSize(index)
  if (top < handle.scrollOffset + headerHeight) {
    handle.scrollToIndex(index, { align: 'start', offset: -headerHeight })
  } else if (bottom > handle.scrollOffset + handle.viewportSize) {
    handle.scrollToIndex(index, { align: 'end' })
  }
}
