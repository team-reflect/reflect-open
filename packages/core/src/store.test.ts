import { describe, expect, it, vi } from 'vitest'
import { combineStores, deriveStore, WritableStore } from './store.ts'

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
    const unlisten = store.subscribe(() => {})
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
})
