import { useEffect, type ReactElement } from 'react'
import { marketingVersion } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { useToastController } from '@/lib/use-toasts.ts'
import { useStore } from '@/lib/use-store.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { WhatsNewItems } from './whats-new-items.tsx'

const WHATS_NEW_TOAST_ID = 'reflect-whats-new'
const WHATS_NEW_TOAST_TIMEOUT_MS = 10_000

/**
 * The desktop What's New: a toast while it is offered, then the dialog while
 * it is shown. Every way of closing the dialog marks the version seen.
 */
export function WhatsNewDialog(): ReactElement {
  const { whatsNew } = useAppServices()
  const { platform } = useCoreServices()
  const toastController = useToastController()
  const phase = useStore(whatsNew.phase)
  const version = marketingVersion(platform.appVersion)
  useEffect(() => {
    if (phase !== 'offered') {
      toastController.close(WHATS_NEW_TOAST_ID)
      return
    }
    toastController.add({
      id: WHATS_NEW_TOAST_ID,
      title: `Reflect updated to ${version}`,
      description: 'See what’s new in this version.',
      timeout: WHATS_NEW_TOAST_TIMEOUT_MS,
      onClose: whatsNew.decline,
      actionProps: {
        children: 'What’s new',
        onClick: () => {
          whatsNew.accept()
          toastController.close(WHATS_NEW_TOAST_ID)
        },
      },
    })
  }, [toastController, phase, version, whatsNew])
  return (
    <Dialog
      open={phase === 'shown'}
      onOpenChange={(open) => {
        if (!open) {
          whatsNew.dismiss()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="gap-1.5">
          <p className="text-xs font-semibold text-accent dark:text-accent-hover">New in Reflect</p>
          <DialogTitle className="text-xl font-semibold tracking-tight">What’s new</DialogTitle>
          <DialogDescription>Version {version}</DialogDescription>
        </DialogHeader>
        <WhatsNewItems items={whatsNew.items} />
        <DialogFooter>
          <Button onClick={whatsNew.dismiss}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
