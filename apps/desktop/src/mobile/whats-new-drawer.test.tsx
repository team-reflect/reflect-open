import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { ReviewService, WhatsNewPhase, WhatsNewService } from '@reflect/app'
import { WritableStore } from '@reflect/core'
import { swipeDrawerClosed } from '@/test-utils/drawer.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WhatsNewDrawer } from './whats-new-drawer.tsx'

function createFakeWhatsNew() {
  const phase = new WritableStore<WhatsNewPhase>('shown')
  let dismissed = 0
  const whatsNew: WhatsNewService = {
    items: [
      {
        id: 'chat',
        title: 'Chat in the All tab',
        body: 'Ask your notes anywhere.',
        platforms: ['ios'],
      },
    ],
    phase,
    override: new WritableStore(false),
    setOverride: () => {},
    accept: () => {},
    decline: () => {},
    dismiss: () => {
      dismissed += 1
      phase.set('hidden')
    },
    start: () => () => {},
  }
  return { whatsNew, dismissed: () => dismissed }
}

function createFakeReview() {
  const calls: string[] = []
  const review: ReviewService = {
    override: new WritableStore(false),
    setOverride: () => {},
    shouldAsk: () => Promise.resolve(true),
    markShown: () => {
      calls.push('markShown')
    },
    requestReview: () => {
      calls.push('requestReview')
    },
    writeReview: () => {
      calls.push('writeReview')
    },
    sendFeedback: (channel) => {
      calls.push(channel)
    },
  }
  return { review, calls }
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

  it('turns to the review page on Continue when the review service asks', async () => {
    const { whatsNew, dismissed } = createFakeWhatsNew()
    const { review, calls } = createFakeReview()
    await renderInApp(<WhatsNewDrawer />, { appServices: { whatsNew, review }, servicesOnly: true })

    await userEvent.click(page.getByRole('button', { name: 'Continue' }))
    await expect.element(page.getByText('Enjoying Reflect?')).toBeVisible()
    expect(dismissed()).toBe(0)

    await userEvent.click(page.getByRole('button', { name: 'Rate Reflect' }))
    await userEvent.click(page.getByRole('button', { name: 'Write a review' }))
    await userEvent.click(page.getByRole('button', { name: 'Discord' }))
    await userEvent.click(page.getByRole('button', { name: 'GitHub' }))
    await userEvent.click(page.getByRole('button', { name: 'Email' }))
    expect(calls).toEqual([
      'markShown',
      'requestReview',
      'writeReview',
      'discord',
      'github',
      'email',
    ])

    await userEvent.click(page.getByRole('button', { name: 'Not now' }))
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(dismissed()).toBe(1)
  })
})
