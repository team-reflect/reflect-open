import type { KeyedToastSpec } from '../app/toast-service.ts'
import type { WhatsNewPhase, WhatsNewService } from './whats-new-service.ts'

export const WHATS_NEW_TOAST_ID = 'reflect-whats-new'

const WHATS_NEW_TOAST_TIMEOUT_MS = 10_000

/**
 * The toast that offers What's New: its action opens What's New, and every
 * other close declines the offer.
 */
export function getWhatsNewToasts(
  phase: WhatsNewPhase,
  version: string,
  whatsNew: WhatsNewService,
): readonly KeyedToastSpec[] {
  if (phase !== 'offered') {
    return []
  }
  return [
    {
      id: WHATS_NEW_TOAST_ID,
      title: `Reflect updated to ${version}`,
      description: 'See what’s new in this version.',
      timeout: WHATS_NEW_TOAST_TIMEOUT_MS,
      onClose: whatsNew.decline,
      action: { label: 'What’s new', run: whatsNew.accept },
    },
  ]
}
