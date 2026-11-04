import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WhatsNewGate, WhatsNewService } from '@reflect/app'
import { WritableStore } from '@reflect/core'
import type { MockToastAddOptions } from '@/test-utils/toast.ts'
import { attachWhatsNewToast } from './whats-new-toast.ts'

const toast = vi.hoisted(() => ({
  add: vi.fn<(options: MockToastAddOptions) => string>(),
  close: vi.fn(),
}))

vi.mock('@/components/ui/toast.tsx', () => ({ toast }))

afterEach(() => {
  toast.add.mockClear()
  toast.close.mockClear()
})

function createFakeWhatsNew(kind: WhatsNewGate['kind']) {
  const gate = new WritableStore<WhatsNewGate>({ kind })
  const calls: string[] = []
  const whatsNew: WhatsNewService = {
    items: [],
    gate,
    override: new WritableStore(false),
    setOverride: () => {},
    accept: () => {
      calls.push('accept')
      gate.set({ kind: 'whatsNew' })
    },
    decline: () => {
      calls.push('decline')
    },
    dismiss: () => {},
    start: () => () => {},
  }
  return { whatsNew, gate, calls }
}

describe('attachWhatsNewToast', () => {
  it('offers What’s New in a toast that times out', () => {
    const { whatsNew } = createFakeWhatsNew('offer')
    attachWhatsNewToast(whatsNew, '0.19.0')

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reflect-whats-new',
        title: 'Reflect updated to 0.19.0',
        timeout: 10_000,
      }),
    )
  })

  it('accepts the offer and closes the toast on its action', () => {
    const { whatsNew, gate, calls } = createFakeWhatsNew('offer')
    attachWhatsNewToast(whatsNew, '0.19.0')

    const options = toast.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('What’s new')
    options?.actionProps?.onClick()

    expect(calls).toEqual(['accept'])
    expect(gate.get().kind).toBe('whatsNew')
    expect(toast.close).toHaveBeenCalledWith('reflect-whats-new')
  })

  it('declines the offer when the toast closes any other way', () => {
    const { whatsNew, calls } = createFakeWhatsNew('offer')
    attachWhatsNewToast(whatsNew, '0.19.0')

    toast.add.mock.lastCall?.[0]?.onClose?.()

    expect(calls).toEqual(['decline'])
  })

  it('shows no toast without an offer, and stops following the gate on detach', () => {
    const { whatsNew, gate } = createFakeWhatsNew('hidden')
    const detach = attachWhatsNewToast(whatsNew, '0.19.0')
    expect(toast.add).not.toHaveBeenCalled()

    detach()
    gate.set({ kind: 'offer' })
    expect(toast.add).not.toHaveBeenCalled()
  })
})
