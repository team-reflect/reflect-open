import type { ReactElement } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx'
import { LicenseList } from './license-list.tsx'

/** The desktop Open Source Licenses dialog. */
export function LicensesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-170 max-h-11/12 flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="flex min-h-0 flex-1 flex-col bg-muted/50">
          <div className="px-6 pt-6 pb-3">
            <DialogTitle className="text-base font-semibold">Open Source Licenses</DialogTitle>
            <DialogDescription className="mt-1 text-sm text-text-muted">
              Reflect Open is built on these open source components.
            </DialogDescription>
          </div>
          <LicenseList className="flex-1 px-6 pt-1 pb-6" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
