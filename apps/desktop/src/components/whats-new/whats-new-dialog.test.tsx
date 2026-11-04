import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WhatsNewPhase, WhatsNewService } from '@reflect/app'
import { WritableStore } from '@reflect/core'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import type { MockToastAddOptions } from '@/test-utils/toast.ts'
import { WhatsNewDialog } from './whats-new-dialog.tsx'

const toast = vi.hoisted(() => ({
  add: vi.fn<(options: MockToastAddOptions) => string>(),
  close: vi.fn(),
}))

vi.mock('@/components/ui/toast.tsx', () => ({ toast }))

afterEach(() => {
  toast.add.mockClear()
  toast.close.mockClear()
})

function createFakeWhatsNew(initial: WhatsNewPhase = 'shown') {
  const phase = new WritableStore<WhatsNewPhase>(initial)
  const calls: string[] = []
  let dismissed = 0
  const whatsNew: WhatsNewService = {
    items: [
      { title: 'Chat in the All tab', body: 'Ask your notes anywhere.', platforms: ['desktop'] },
    ],
    phase,
    override: new WritableStore(false),
    setOverride: () => {},
    accept: () => {
      calls.push('accept')
      phase.set('shown')
    },
    decline: () => {
      calls.push('decline')
    },
    dismiss: () => {
      dismissed += 1
      phase.set('hidden')
    },
    start: () => () => {},
  }
  return { whatsNew, phase, calls, dismissed: () => dismissed }
}

describe('WhatsNewDialog', () => {
  it('shows the items and closes on Continue', async () => {
    const { whatsNew, dismissed } = createFakeWhatsNew()
    await renderInApp(<WhatsNewDialog />, { appServices: { whatsNew }, servicesOnly: true })

    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Continue' }))

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(dismissed()).toBe(1)
  })

  it('keeps the items while the dialog animates closed', async () => {
    const { whatsNew } = createFakeWhatsNew()
    await renderInApp(<WhatsNewDialog />, { appServices: { whatsNew }, servicesOnly: true })
    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()

    await act(() => whatsNew.dismiss())

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.hasAttribute('data-closed')).toBe(true)
    expect(dialog?.textContent).toContain('Chat in the All tab')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('marks the version seen on Escape', async () => {
    const { whatsNew, dismissed } = createFakeWhatsNew()
    await renderInApp(<WhatsNewDialog />, { appServices: { whatsNew }, servicesOnly: true })

    await expect.element(page.getByRole('dialog')).toBeVisible()
    await userEvent.keyboard('{Escape}')

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(dismissed()).toBe(1)
  })

  it('offers What’s New in a toast that times out', async () => {
    const { whatsNew } = createFakeWhatsNew('offered')
    await renderInApp(<WhatsNewDialog />, { appServices: { whatsNew }, servicesOnly: true })

    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reflect-whats-new', timeout: 10_000 }),
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens the dialog from the toast action', async () => {
    const { whatsNew, calls } = createFakeWhatsNew('offered')
    await renderInApp(<WhatsNewDialog />, { appServices: { whatsNew }, servicesOnly: true })

    const options = toast.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('What’s new')
    await act(() => options?.actionProps?.onClick())

    expect(calls).toEqual(['accept'])
    expect(toast.close).toHaveBeenCalledWith('reflect-whats-new')
    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()
  })

  it('declines the offer when the toast closes any other way', async () => {
    const { whatsNew, calls } = createFakeWhatsNew('offered')
    await renderInApp(<WhatsNewDialog />, { appServices: { whatsNew }, servicesOnly: true })

    toast.add.mock.lastCall?.[0]?.onClose?.()

    expect(calls).toEqual(['decline'])
  })
})
