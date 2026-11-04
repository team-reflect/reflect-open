/**
 * The platforms a What's New item can target.
 */
export type WhatsNewPlatform = 'desktop' | 'ios'

/**
 * One user-facing change.
 */
export interface WhatsNewItem {
  readonly title: string
  readonly body: string
  readonly platforms: readonly WhatsNewPlatform[]
}

/**
 * User-facing changes keyed by marketing version, newest first. A beta
 * appends to its marketing version's list, so each beta update shows
 * everything so far.
 */
export const WHATS_NEW: Readonly<Record<string, readonly WhatsNewItem[]>> = {}
