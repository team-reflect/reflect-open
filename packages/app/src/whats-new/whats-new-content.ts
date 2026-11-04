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
  ],
}

/**
 * Marketing versions whose What's New is followed by the review page on iOS.
 * Mark at most three a year, matching Apple's prompt quota, and only versions
 * with an iOS item in {@link WHATS_NEW}.
 */
export const ASK_FOR_REVIEW_VERSIONS: ReadonlySet<string> = new Set()
