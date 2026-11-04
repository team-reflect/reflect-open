import type { ReactElement } from 'react'
import { Check } from 'lucide-react'
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
        <DialogHeader className="gap-1.5">
          <p className="text-xs font-semibold text-primary">New in Reflect</p>
          <DialogTitle className="text-xl font-semibold tracking-tight">What’s new</DialogTitle>
          <DialogDescription>Version {marketingVersion(platform.appVersion)}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col divide-y divide-border">
          {gate.items?.map((item) => (
            <li key={item.title} className="flex gap-3 py-3">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                <Check className="size-3" strokeWidth={3} />
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="leading-5 font-medium text-text">{item.title}</p>
                <p className="text-text-secondary">{item.body}</p>
              </div>
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
