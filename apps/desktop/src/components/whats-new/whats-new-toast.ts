import type { WhatsNewService } from '@reflect/app'
import type { Unlisten } from '@reflect/core'
import { toast } from '@/components/ui/toast.tsx'

const WHATS_NEW_TOAST_ID = 'reflect-whats-new'
const WHATS_NEW_TOAST_TIMEOUT_MS = 10_000

/**
 * Mirrors the What's New offer into a toast that opens What's New on its
 * action and declines the offer on any other close. Returns a detach.
 */
export function attachWhatsNewToast(whatsNew: WhatsNewService, version: string): Unlisten {
  const sync = (): void => {
    if (whatsNew.gate.get().kind !== 'offer') {
      toast.close(WHATS_NEW_TOAST_ID)
      return
    }
    toast.add({
      id: WHATS_NEW_TOAST_ID,
      title: `Reflect updated to ${version}`,
      description: 'See what’s new in this version.',
      timeout: WHATS_NEW_TOAST_TIMEOUT_MS,
      onClose: whatsNew.decline,
      actionProps: {
        children: 'What’s new',
        onClick: () => {
          whatsNew.accept()
          toast.close(WHATS_NEW_TOAST_ID)
        },
      },
    })
  }
  sync()
  return whatsNew.gate.subscribe(sync)
}
