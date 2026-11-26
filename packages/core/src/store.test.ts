import { describe, expect, it, vi } from 'vitest'
import { combineStores, deriveStore, WritableStore, type Store } from './store.ts'
import type { Unlisten } from './unlisten.ts'
import { noop } from '@ocavue/utils'

describe('WritableStore', () => {
  it('returns the value it holds', () => {
    const value = { count: 1 }
    const store = new WritableStore(value)
    expect(store.get()).toBe(value)
  })

  it('replaces the value and notifies the listeners', () => {
    const store = new WritableStore(1)
    const listener = vi.fn(() => {
      expect(store.get()).toBe(2)
    })
    store.subscribe(listener)
    store.set(2)
    expect(store.get()).toBe(2)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('ignores an equal value', () => {
    const store = new WritableStore(1)
    const listener = vi.fn()
    store.subscribe(listener)
    store.set(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('compares with `isEqual` and keeps the previous reference', () => {
    const before = { count: 1 }
    const store = new WritableStore(before, (a, b) => a.count === b.count)
    const listener = vi.fn()
    store.subscribe(listener)
    store.set({ count: 1 })
    expect(store.get()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying a listener after it unsubscribes', () => {
    const store = new WritableStore(1)
    const listener = vi.fn()
    const unlisten = store.subscribe(listener)
    unlisten()
    unlisten()
    store.set(2)
    expect(listener).not.toHaveBeenCalled()
  })

  it('reports whether it has listeners', () => {
    const store = new WritableStore(1)
    expect(store.subscribed()).toBe(false)
    const unlisten = store.subscribe(noop)
    expect(store.subscribed()).toBe(true)
    unlisten()
    expect(store.subscribed()).toBe(false)
  })
})

describe('deriveStore', () => {
  it('derives again only when the source returns a new reference', () => {
    const source = new WritableStore({ count: 1 })
    const derive = vi.fn((value: { count: number }) => value.count * 2)
    const derived = deriveStore(source, derive)
    expect(derived.get()).toBe(2)
    expect(derived.get()).toBe(2)
    expect(derive).toHaveBeenCalledOnce()

    source.set({ count: 2 })
    expect(derived.get()).toBe(4)
    expect(derive).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous reference for an equal result and does not notify', () => {
    const source = new WritableStore({ tags: ['a'], other: 0 })
    const derived = deriveStore(
      source,
      (value) => [...value.tags],
      (a, b) => a.length === b.length && a.every((tag, i) => tag === b[i]),
    )
    const before = derived.get()
    const listener = vi.fn()
    derived.subscribe(listener)

    source.set({ tags: ['a'], other: 1 })
    expect(derived.get()).toBe(before)
    expect(listener).not.toHaveBeenCalled()

    source.set({ tags: ['b'], other: 1 })
    expect(derived.get()).toEqual(['b'])
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('combineStores', () => {
  it('derives from the values of every store', () => {
    const a = new WritableStore(1)
    const b = new WritableStore('x')
    const combined = combineStores([a, b], (count, label) => `${label}${count}`)
    expect(combined.get()).toBe('x1')

    a.set(2)
    expect(combined.get()).toBe('x2')
    b.set('y')
    expect(combined.get()).toBe('y2')
  })

  it('derives again only when a store returns a new reference', () => {
    const a = new WritableStore(1)
    const b = new WritableStore(2)
    const derive = vi.fn((x: number, y: number) => ({ sum: x + y }))
    const combined = combineStores([a, b], derive)
    const before = combined.get()
    expect(combined.get()).toBe(before)
    expect(derive).toHaveBeenCalledOnce()
  })

  it('notifies only when the combined value changes', () => {
    const a = new WritableStore(1)
    const b = new WritableStore(2)
    const combined = combineStores([a, b], (x, y) => x > y)
    const listener = vi.fn()
    combined.subscribe(listener)

    a.set(0)
    expect(listener).not.toHaveBeenCalled()
    a.set(3)
    expect(listener).toHaveBeenCalledOnce()
    expect(combined.get()).toBe(true)
  })

  it('filters for each subscriber on its own', () => {
    const source = new WritableStore(1)
    const combined = combineStores([source], (value) => value % 2)
    const early = vi.fn()
    combined.subscribe(early)
    source.set(2)
    expect(early).toHaveBeenCalledOnce()

    const late = vi.fn()
    combined.subscribe(late)
    source.set(4)
    expect(early).toHaveBeenCalledOnce()
    expect(late).not.toHaveBeenCalled()

    source.set(5)
    expect(early).toHaveBeenCalledTimes(2)
    expect(late).toHaveBeenCalledOnce()
  })

  it('reads consistent values from a store and a store derived from it', () => {
    const source = new WritableStore(1)
    const doubled = deriveStore(source, (value) => value * 2)
    const combined = combineStores([source, doubled], (value, double) => double === value * 2)
    const seen: boolean[] = []
    combined.subscribe(() => {
      seen.push(combined.get())
    })

    source.set(2)
    source.set(3)
    expect(combined.get()).toBe(true)
    expect(seen).toEqual([])
  })

  it('subscribes to the stores only while it has subscribers', () => {
    const a = new WritableStore(1)
    const b = new WritableStore(2)
    const subscribeA = vi.spyOn(a, 'subscribe')
    const subscribeB = vi.spyOn(b, 'subscribe')
    const combined = combineStores([a, b], (x, y) => x + y)
    combined.get()
    expect(subscribeA).not.toHaveBeenCalled()
    expect(subscribeB).not.toHaveBeenCalled()

    const listener = vi.fn()
    const unlisten = combined.subscribe(listener)
    expect(subscribeA).toHaveBeenCalledOnce()
    expect(subscribeB).toHaveBeenCalledOnce()

    unlisten()
    a.set(10)
    expect(listener).not.toHaveBeenCalled()
  })

  it('derives once and notifies once per write in a diamond', () => {
    const source = new WritableStore(1)
    const doubled = deriveStore(source, (value) => value * 2)
    const derive = vi.fn((value: number, double: number) => value + double)
    const combined = combineStores([source, doubled], derive)
    const listener = vi.fn()
    combined.subscribe(listener)
    derive.mockClear()

    source.set(2)
    expect(combined.get()).toBe(6)
    expect(derive).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('reads a store on every `get` while nothing is subscribed', () => {
    const source = createOpaqueStore(1)
    const combined = combineStores([source.store], (value) => value)
    combined.get()
    combined.get()
    expect(source.get).toHaveBeenCalledTimes(2)
  })

  it('subscribes to each store once, until the last subscriber leaves', () => {
    const source = createOpaqueStore(1)
    const combined = combineStores([source.store], (value) => value * 2)
    const listeners = [vi.fn(), vi.fn(), vi.fn()]
    const unlistens = listeners.map((listener) => combined.subscribe(listener))
    expect(source.subscribe).toHaveBeenCalledOnce()

    source.set(2)
    for (const listener of listeners) {
      expect(listener).toHaveBeenCalledOnce()
    }

    unlistens[0]!()
    unlistens[0]!()
    unlistens[1]!()
    expect(source.unlisten).not.toHaveBeenCalled()
    unlistens[2]!()
    expect(source.unlisten).toHaveBeenCalledOnce()
  })

  it('notifies a function subscribed twice once per subscription', () => {
    const source = new WritableStore(1)
    const combined = combineStores([source], (value) => value)
    const listener = vi.fn()
    const first = combined.subscribe(listener)
    combined.subscribe(listener)
    source.set(2)
    expect(listener).toHaveBeenCalledTimes(2)

    first()
    source.set(3)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('notifies a later subscriber only of the latest value after a write in a listener', () => {
    const source = new WritableStore(0)
    const combined = combineStores([source], (value) => value)
    combined.subscribe(() => {
      if (combined.get() === 1) {
        source.set(2)
      }
    })
    const seen: number[] = []
    combined.subscribe(() => {
      seen.push(combined.get())
    })

    source.set(1)
    expect(seen).toEqual([2])
  })

  it('does not notify a subscriber that joins during a notification of that change', () => {
    const source = new WritableStore(1)
    const combined = combineStores([source], (value) => value)
    const late = vi.fn()
    combined.subscribe(() => {
      combined.subscribe(late)
    })

    source.set(2)
    expect(late).not.toHaveBeenCalled()
  })

  it('does not notify a subscriber that leaves during a notification', () => {
    const source = new WritableStore(1)
    const combined = combineStores([source], (value) => value)
    const second = vi.fn()
    let unlistenSecond: Unlisten = noop
    combined.subscribe(() => {
      unlistenSecond()
    })
    unlistenSecond = combined.subscribe(second)

    source.set(2)
    expect(second).not.toHaveBeenCalled()
  })
})

/**
 * A store whose `get` and `subscribe` are spies, like a service that wraps them.
 */
function createOpaqueStore(initial: number) {
  const inner = new WritableStore(initial)
  const unlisten = vi.fn()
  const get = vi.fn(() => inner.get())
  const subscribe = vi.fn((listener: VoidFunction) => {
    const stop = inner.subscribe(listener)
    return () => {
      unlisten()
      stop()
    }
  })
  const store: Store<number> = { get, subscribe }
  return { store, get, subscribe, unlisten, set: inner.set }
}
