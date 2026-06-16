import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'

/**
 * Multi-select for the Tasks view (Plan 18, V1 parity). Selection is a set of
 * task keys ({@link taskKey}) over the **flat visible order** — the rows as they
 * render, groups then rows — which the screen passes in. Two cursors drive range
 * selection the way V1's list does: `anchor` is the fixed end set by a plain
 * click / toggle, `cursor` is the moving end a shifted click or arrow extends to.
 * Both are refs, not state: they steer the next gesture but never the render
 * (only `selected` does), so reading them mid-gesture is always current.
 *
 * Mouse parity (V1's `clickSelect`): a plain click selects exclusively, ⌘/Ctrl
 * toggles one, Shift extends a range from the anchor. Keyboard parity: ↑/↓ move a
 * single selection, Shift+↑/↓ extend the range, ⌘A selects all, Esc clears.
 *
 * Keys that vanish (a task completed or filtered out from under the selection)
 * are pruned as the order changes, so the count and the sole-selection check
 * (which mounts the inline editor) can't be wrong about a row that's gone.
 */
export interface TaskSelection {
  selected: ReadonlySet<string>
  selectedCount: number
  isSelected: (key: string) => boolean
  /** Exactly this key is selected — the state that opens the inline editor. */
  isSoleSelected: (key: string) => boolean
  /** Apply a row click, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers. */
  clickSelect: (key: string, event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  selectAll: () => void
  clear: () => void
  /** ↑/↓: move a single selection by one in the flat order. */
  move: (direction: 1 | -1) => void
  /** Shift+↑/↓: extend the range from the anchor by one. */
  extend: (direction: 1 | -1) => void
  /**
   * The row the next gesture pivots on — the moving end (`cursor`), else the
   * `anchor` — read live from the refs, never render order. Return-to-add targets
   * its note, so a multi-note selection adds to the row you last touched, not
   * whichever happens to render last.
   */
  activeKey: () => string | null
}

/** Clamp `index` into `[0, length)`. */
function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1))
}

export function useTaskSelection(orderedKeys: readonly string[]): TaskSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // The latest order, read by mutators that run from a keydown listener closing
  // over an older render.
  const orderRef = useRef(orderedKeys)
  useEffect(() => {
    orderRef.current = orderedKeys
  })
  const anchorRef = useRef<string | null>(null)
  const cursorRef = useRef<string | null>(null)

  // Prune keys that left the visible set so the count and sole-selection check
  // never count a gone row. `orderedKeys` is memoized by the screen, so this
  // only runs when the set of rows actually changes.
  useEffect(() => {
    const valid = new Set(orderedKeys)
    // Reconcile the selection to a changed visible order; the functional update
    // returns the same Set when nothing vanished, so steady-state renders never
    // cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected((current) =>
      [...current].every((key) => valid.has(key))
        ? current
        : new Set([...current].filter((key) => valid.has(key))),
    )
    if (anchorRef.current !== null && !valid.has(anchorRef.current)) {
      anchorRef.current = null
    }
    if (cursorRef.current !== null && !valid.has(cursorRef.current)) {
      cursorRef.current = null
    }
  }, [orderedKeys])

  const rangeBetween = useCallback((a: string, b: string): string[] => {
    const order = orderRef.current
    const ai = order.indexOf(a)
    const bi = order.indexOf(b)
    if (ai === -1 || bi === -1) {
      return [b]
    }
    const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai]
    return order.slice(lo, hi + 1)
  }, [])

  const clickSelect = useCallback<TaskSelection['clickSelect']>(
    (key, event) => {
      if (event.metaKey || event.ctrlKey) {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(key)) {
            next.delete(key)
          } else {
            next.add(key)
          }
          return next
        })
        anchorRef.current = key
        cursorRef.current = key
        return
      }
      if (event.shiftKey && anchorRef.current !== null) {
        setSelected(new Set(rangeBetween(anchorRef.current, key)))
        cursorRef.current = key
        return
      }
      setSelected(new Set([key]))
      anchorRef.current = key
      cursorRef.current = key
    },
    [rangeBetween],
  )

  const selectAll = useCallback(() => {
    const order = orderRef.current
    if (order.length === 0) {
      return
    }
    setSelected(new Set(order))
    anchorRef.current = order[0]!
    cursorRef.current = order[order.length - 1]!
  }, [])

  const clear = useCallback(() => {
    setSelected(new Set())
    anchorRef.current = null
    cursorRef.current = null
  }, [])

  const move = useCallback((direction: 1 | -1) => {
    const order = orderRef.current
    if (order.length === 0) {
      return
    }
    const from = cursorRef.current ?? anchorRef.current
    const index = from === null ? -1 : order.indexOf(from)
    const next =
      index === -1 ? (direction === 1 ? 0 : order.length - 1) : clamp(index + direction, order.length)
    const key = order[next]!
    setSelected(new Set([key]))
    anchorRef.current = key
    cursorRef.current = key
  }, [])

  const extend = useCallback(
    (direction: 1 | -1) => {
      const order = orderRef.current
      if (order.length === 0) {
        return
      }
      const base = anchorRef.current
      if (base === null) {
        move(direction)
        return
      }
      const from = cursorRef.current ?? base
      const index = order.indexOf(from)
      const next = clamp((index === -1 ? 0 : index) + direction, order.length)
      const key = order[next]!
      setSelected(new Set(rangeBetween(base, key)))
      cursorRef.current = key
    },
    [move, rangeBetween],
  )

  const activeKey = useCallback(() => cursorRef.current ?? anchorRef.current, [])

  return {
    selected,
    selectedCount: selected.size,
    isSelected: (key) => selected.has(key),
    isSoleSelected: (key) => selected.size === 1 && selected.has(key),
    clickSelect,
    selectAll,
    clear,
    move,
    extend,
    activeKey,
  }
}
