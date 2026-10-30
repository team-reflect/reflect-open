import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMotionFlagStore, type MotionFlagStore } from '@/mobile/motion-flags.ts'

/**
 * Motion flags: the URL wins over a stored choice, a stored choice wins over
 * the default, and only a persisted choice survives a reload.
 */

const STORAGE_KEY = 'test:motion-flags'

const DEFINITIONS = {
  drawer: { label: 'Drawer', defaultValue: true },
  pager: { label: 'Pager', defaultValue: false },
}

function load(search: string): MotionFlagStore<keyof typeof DEFINITIONS> {
  return createMotionFlagStore(DEFINITIONS, { storageKey: STORAGE_KEY, search: () => search })
}

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
})

describe('createMotionFlagStore', () => {
  it('keeps a persisted choice across a reload, and only that one', () => {
    const before = load('')
    before.set('drawer', false, { persist: true })
    before.set('pager', true)

    const after = load('')

    expect(after.get('drawer')).toBe(false)
    expect(after.get('pager')).toBe(false)
  })

  it('lets the URL override the stored choices and ignores what it does not know', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ drawer: true, pager: false }))

    const store = load('?motion=drawer:0,pager:1,gone:1,pager')

    expect(store.get('drawer')).toBe(false)
    expect(store.get('pager')).toBe(true)
  })

  it('falls back to the defaults when the stored value is corrupt', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')

    expect(load('').get('drawer')).toBe(true)
  })

  it('drops keys of removed flags when it persists', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ gone: true }))

    load('').set('pager', true, { persist: true })

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '')).toEqual({ pager: true })
  })

  it('tells subscribers about a change and a reset', () => {
    const store = load('?motion=pager:1')
    const listener = vi.fn()
    store.subscribe(listener)

    store.set('drawer', false)
    store.reset()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.get('drawer')).toBe(true)
    expect(store.get('pager')).toBe(false)
  })
})
