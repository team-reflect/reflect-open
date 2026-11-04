import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { WhatsNewGate, WhatsNewService } from '@reflect/app'
import { WritableStore } from '@reflect/core'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WhatsNewDialog } from './whats-new-dialog.tsx'

function createFakeWhatsNew() {
  const gate = new WritableStore<WhatsNewGate>('shown')
  let dismissed = 0
  const whatsNew: WhatsNewService = {
    items: [
      { title: 'Chat in the All tab', body: 'Ask your notes anywhere.', platforms: ['desktop'] },
    ],
    gate,
    override: new WritableStore(false),
    setOverride: () => {},
    dismiss: () => {
      dismissed += 1
      gate.set('hidden')
    },
    start: () => () => {},
  }
  return { whatsNew, dismissed: () => dismissed }
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
})
