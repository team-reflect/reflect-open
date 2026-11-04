import type { ReactElement } from 'react'
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

/**
 * The desktop What's New dialog, open while the What's New gate shows. Every
 * way of closing it marks the version seen.
 */
export function WhatsNewDialog(): ReactElement {
  const { whatsNew } = useAppServices()
  const { platform } = useCoreServices()
  const gate = useStore(whatsNew.gate)
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
        <DialogHeader>
          <DialogTitle>What’s New</DialogTitle>
          <DialogDescription>Version {marketingVersion(platform.appVersion)}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {gate.items?.map((item) => (
            <li key={item.title}>
              <p className="font-medium text-text">{item.title}</p>
              <p className="text-text-muted">{item.body}</p>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={whatsNew.dismiss}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
