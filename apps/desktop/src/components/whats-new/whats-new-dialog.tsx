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
import { useStore } from '@/lib/use-store.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { WhatsNewItems } from './whats-new-items.tsx'
import { attachWhatsNewToast } from './whats-new-toast.ts'

/**
 * The desktop What's New: a toast that offers it, then the dialog. Every way
 * of closing the dialog marks the version seen.
 */
export function WhatsNewDialog(): ReactElement {
  const { whatsNew } = useAppServices()
  const { platform } = useCoreServices()
  const gate = useStore(whatsNew.gate)
  const version = marketingVersion(platform.appVersion)
  useEffect(() => attachWhatsNewToast(whatsNew, version), [whatsNew, version])
  return (
    <Dialog
      open={gate.kind === 'whatsNew'}
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
