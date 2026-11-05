import type { VirtualizerHandle } from 'virtua'

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
