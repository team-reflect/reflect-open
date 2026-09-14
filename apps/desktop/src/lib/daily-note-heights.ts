/**
 * Last rendered pane height per (graph root, day), so a daily row remounts
 * its loading placeholder at the height the note will occupy once loaded,
 * instead of collapsing to the minimum and jumping back when the note
 * arrives. Heights are hints: a stale value costs one ordinary resize
 * compensation, never correctness.
 */
const heights = new Map<string, number>()

function key(root: string, date: string): string {
  return `${root}\n${date}`
}

export function rememberDailyPaneHeight(root: string, date: string, height: number): void {
  heights.set(key(root, date), height)
}

export function savedDailyPaneHeight(root: string, date: string): number | undefined {
  return heights.get(key(root, date))
}
