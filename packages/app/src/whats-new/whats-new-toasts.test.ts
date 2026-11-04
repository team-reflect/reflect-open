import { describe, expect, it, vi } from 'vitest'
import { WritableStore } from '@reflect/core'
import type { WhatsNewPhase, WhatsNewService } from './whats-new-service.ts'
import { getWhatsNewToasts } from './whats-new-toasts.ts'

function createFakeWhatsNew(): WhatsNewService {
  return {
    items: [],
    phase: new WritableStore<WhatsNewPhase>('offered'),
    override: new WritableStore(false),
    setOverride: () => {},
    accept: vi.fn(),
    decline: vi.fn(),
    dismiss: () => {},
    start: () => () => {},
  }
}

describe('getWhatsNewToasts', () => {
  it('offers What’s New in a toast that closes itself, only while offered', () => {
    const whatsNew = createFakeWhatsNew()
    expect(getWhatsNewToasts('offered', '0.19.0', whatsNew)).toEqual([
      expect.objectContaining({
        id: 'reflect-whats-new',
        title: 'Reflect updated to 0.19.0',
        timeout: 10_000,
      }),
    ])
    expect(getWhatsNewToasts('hidden', '0.19.0', whatsNew)).toEqual([])
    expect(getWhatsNewToasts('shown', '0.19.0', whatsNew)).toEqual([])
  })

  it('accepts the offer on its action and declines it on close', () => {
    const whatsNew = createFakeWhatsNew()
    const [toast] = getWhatsNewToasts('offered', '0.19.0', whatsNew)

    expect(toast?.action?.label).toBe('What’s new')
    toast?.action?.run()
    expect(whatsNew.accept).toHaveBeenCalledTimes(1)
    toast?.onClose?.()
    expect(whatsNew.decline).toHaveBeenCalledTimes(1)
  })
})
