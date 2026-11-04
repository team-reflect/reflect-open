import { describe, expect, it } from 'vitest'
import { WritableStore } from '@reflect/core'
import { createTestToastService } from '../testing/toast.ts'
import { syncToasts, type KeyedToastSpec } from './toast-service.ts'

const ONE: KeyedToastSpec = { id: 'one', title: 'One' }
const TWO: KeyedToastSpec = { id: 'two', title: 'Two' }

describe('syncToasts', () => {
  it('shows the specs, replaces a spec with the same id, and closes a spec that leaves', () => {
    const specs = new WritableStore<readonly KeyedToastSpec[]>([ONE, TWO])
    const toasts = createTestToastService()
    syncToasts(specs, toasts)
    expect(toasts.open()).toEqual([ONE, TWO])

    specs.set([{ ...ONE, title: 'One again' }])
    expect(toasts.open()).toEqual([{ ...ONE, title: 'One again' }])
  })

  it('stops following the specs and leaves the open toasts open', () => {
    const specs = new WritableStore<readonly KeyedToastSpec[]>([ONE])
    const toasts = createTestToastService()
    const stop = syncToasts(specs, toasts)

    stop()
    specs.set([TWO])
    expect(toasts.open()).toEqual([ONE])
  })
})
