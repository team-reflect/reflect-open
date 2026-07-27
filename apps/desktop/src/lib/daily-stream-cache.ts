import type { CacheSnapshot } from 'virtua'

interface DailyStreamSnapshot {
  cache: CacheSnapshot
  /**
   * The day window's first day when the snapshot was taken. The snapshot is
   * positional (size per index) and the window anchors at mount-day, so the
   * index↔date mapping shifts across midnight; alignment is only valid while
   * this matches the mounting window's start.
   */
  windowStart: string
}

/**
 * The daily stream's measured row heights, per graph root, surviving the
 * stream's unmount (virtua's own cache dies with the component). Restoring
 * them on remount keeps a saved scroll offset pointing at the same content
 * instead of a layout re-estimated from scratch. Heights are hints: a stale
 * value costs one ordinary resize compensation, never correctness.
 */
const snapshots = new Map<string, DailyStreamSnapshot>()

export function saveDailyStreamSnapshot(root: string, snapshot: DailyStreamSnapshot): void {
  snapshots.set(root, snapshot)
}

export function readDailyStreamSnapshot(root: string, windowStart: string): CacheSnapshot | null {
  const saved = snapshots.get(root)
  return saved !== undefined && saved.windowStart === windowStart ? saved.cache : null
}
