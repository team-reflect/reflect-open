import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WhatsNewPhase, WhatsNewService } from '@reflect/app'
import { WritableStore } from '@reflect/core'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import {
  clickToastAction,
  createTestToastController,
  withToastController,
  type TestToastController,
} from '@/test-utils/toast.tsx'
import { WhatsNewDialog } from './whats-new-dialog.tsx'

let toastController: TestToastController

beforeEach(() => {
  toastController = createTestToastController()
})

function createFakeWhatsNew(initial: WhatsNewPhase = 'shown') {
  const phase = new WritableStore<WhatsNewPhase>(initial)
  const calls: string[] = []
  let dismissed = 0
  const whatsNew: WhatsNewService = {
    items: [
      {
        id: 'chat',
        title: 'Chat in the All tab',
        body: 'Ask your notes anywhere.',
        platforms: ['darwin'],
      },
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
    await renderInApp(<WhatsNewDialog />, {
      appServices: { whatsNew },
      servicesOnly: true,
      wrapper: withToastController(toastController),
    })

    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Continue' }))

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(dismissed()).toBe(1)
  })

  it('keeps the items while the dialog animates closed', async () => {
    const { whatsNew } = createFakeWhatsNew()
    await renderInApp(<WhatsNewDialog />, {
      appServices: { whatsNew },
      servicesOnly: true,
      wrapper: withToastController(toastController),
    })
    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()

    await act(() => whatsNew.dismiss())

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.hasAttribute('data-closed')).toBe(true)
    expect(dialog?.textContent).toContain('Chat in the All tab')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('marks the version seen on Escape', async () => {
    const { whatsNew, dismissed } = createFakeWhatsNew()
    await renderInApp(<WhatsNewDialog />, {
      appServices: { whatsNew },
      servicesOnly: true,
      wrapper: withToastController(toastController),
    })

    await expect.element(page.getByRole('dialog')).toBeVisible()
    await userEvent.keyboard('{Escape}')

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(dismissed()).toBe(1)
  })

  it('offers What’s New in a toast that times out', async () => {
    const { whatsNew } = createFakeWhatsNew('offered')
    await renderInApp(<WhatsNewDialog />, {
      appServices: { whatsNew },
      servicesOnly: true,
      wrapper: withToastController(toastController),
    })

    expect(toastController.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reflect-whats-new', timeout: 10_000 }),
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens the dialog from the toast action', async () => {
    const { whatsNew, calls } = createFakeWhatsNew('offered')
    await renderInApp(<WhatsNewDialog />, {
      appServices: { whatsNew },
      servicesOnly: true,
      wrapper: withToastController(toastController),
    })

    const options = toastController.add.mock.lastCall?.[0]
    expect(options?.actionProps?.children).toBe('What’s new')
    await act(() => {
      clickToastAction(options)
    })

    // Closing the toast runs `onClose`. The real service ignores `decline`
    // after `accept`.
    expect(calls).toEqual(['accept', 'decline'])
    expect(toastController.open()).toEqual([])
    await expect.element(page.getByText('Chat in the All tab')).toBeVisible()
  })

  it('declines the offer when the toast closes any other way', async () => {
    const { whatsNew, calls } = createFakeWhatsNew('offered')
    await renderInApp(<WhatsNewDialog />, {
      appServices: { whatsNew },
      servicesOnly: true,
      wrapper: withToastController(toastController),
    })

    toastController.close('reflect-whats-new')

    expect(calls).toEqual(['decline'])
  })
})
