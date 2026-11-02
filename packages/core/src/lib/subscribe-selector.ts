import type { Unlisten } from '../unlisten.ts'

/**
 * Calls `listener` when `select()` returns a value that `isEqual` rejects,
 * checked on every `subscribe` notification. Never called for the current value.
 */
export function subscribeSelector<S>(
  subscribe: (listener: () => void) => Unlisten,
  select: () => S,
  listener: () => void,
  isEqual: (a: S, b: S) => boolean = Object.is,
): Unlisten {
  let previous = select()
  return subscribe(() => {
    const next = select()
    if (isEqual(previous, next)) {
      return
    }
    previous = next
    listener()
  })
}
