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
      <DialogContent className="flex h-[min(720px,85vh)] flex-col gap-0 p-0 sm:max-w-3xl">
        <div className="border-b border-border px-5 pt-4 pb-3">
          <DialogTitle>Open Source Licenses</DialogTitle>
          <DialogDescription className="mt-1.5">
            Reflect Open is built on these open source components.
          </DialogDescription>
        </div>
        <LicenseList className="flex-1 px-5" />
      </DialogContent>
    </Dialog>
  )
}
