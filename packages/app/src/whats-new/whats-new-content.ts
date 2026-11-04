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
      title: 'Faster, smoother gestures',
      body: 'Swipes, sheets, and image dragging respond faster and move more smoothly.',
      platforms: ['ios'],
    },
    {
      title: 'Sheets with depth',
      body: 'Open sheets now float above the page, which steps back to give them room.',
      platforms: ['ios'],
    },
  ],
}
