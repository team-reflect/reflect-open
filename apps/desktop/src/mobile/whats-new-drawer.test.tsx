import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { WhatsNewGate, WhatsNewService } from '@reflect/app'
import { WritableStore } from '@reflect/core'
import { swipeDrawerClosed } from '@/test-utils/drawer.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WhatsNewDrawer } from './whats-new-drawer.tsx'

function createFakeWhatsNew() {
  const gate = new WritableStore<WhatsNewGate>({
    kind: 'whatsNew',
    items: [{ title: 'Chat in the All tab', body: 'Ask your notes anywhere.', platforms: ['ios'] }],
  })
  let dismissed = 0
  const whatsNew: WhatsNewService = {
    gate,
    override: new WritableStore(false),
    setOverride: () => {},
    dismiss: () => {
      dismissed += 1
      gate.set({ kind: 'hidden' })
    },
    start: () => () => {},
  }
  return { whatsNew, dismissed: () => dismissed }
}

describe('WhatsNewDrawer', () => {
  it('shows the items and closes on Continue', async () => {
    const { whatsNew, dismissed } = createFakeWhatsNew()
    await renderInApp(<WhatsNewDrawer />, { appServices: { whatsNew }, servicesOnly: true })

    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Continue' }))

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(dismissed()).toBe(1)
  })

  it('marks the version seen when swiped closed', async () => {
    const { whatsNew, dismissed } = createFakeWhatsNew()
    await renderInApp(<WhatsNewDrawer />, { appServices: { whatsNew }, servicesOnly: true })

    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()
    await swipeDrawerClosed()

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(dismissed()).toBe(1)
  })
})
