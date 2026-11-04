import type { AppPlatform } from '@reflect/core'

/**
 * One user-facing change.
 */
export interface WhatsNewItem {
  readonly title: string
  readonly body: string
  readonly platforms: readonly AppPlatform[]
}

/**
 * User-facing changes keyed by marketing version. A beta appends to its
 * marketing version's list, so each beta update shows everything so far.
 */
export const WHATS_NEW: Readonly<Record<string, readonly WhatsNewItem[]>> = {
  '0.18.0': [
    {
      title: 'What’s New',
      body: 'After an update, Reflect now shows what changed. This is the first one.',
      platforms: ['desktop', 'ios'],
    },
    {
      title: 'Smoother everywhere',
      body: 'Swiping between days, the week strip, swipe back, swipe actions on rows, bottom sheets, and dragging images all feel smoother.',
      platforms: ['ios'],
    },
    {
      title: 'Depth behind sheets',
      body: 'When a sheet opens, the page behind it steps back, so you always know where you are.',
      platforms: ['ios'],
    },
  ],
}
