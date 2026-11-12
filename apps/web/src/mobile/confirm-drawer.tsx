import { useState, type ReactElement } from 'react'
import type { MaybePromise } from '@reflect/utils'
import { Button } from '@/components/ui/button.tsx'
import { describeActionError } from '@/mobile/chrome/chrome-action.ts'
import type { ChromeConfirm } from '@/mobile/chrome/screen-chrome.ts'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/mobile/scroll-drawer.tsx'

interface ConfirmDrawerProps {
  confirm: ChromeConfirm
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Runs the confirmed action. The drawer stays open and shows a rejection.
   */
  onConfirm: () => MaybePromise<void>
}

/**
 * A confirmation in a bottom drawer, with one destructive button and Cancel.
 */
export function ConfirmDrawer({
  confirm,
  open,
  onOpenChange,
  onConfirm,
}: ConfirmDrawerProps): ReactElement {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ReturnType<typeof describeActionError> | null>(null)

  const handleOpenChange = (next: boolean): void => {
    if (!pending) {
      setError(null)
      onOpenChange(next)
    }
  }

  const runConfirmed = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (caught) {
      setError(describeActionError(caught))
    }
    setPending(false)
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent>
        <DrawerTitle>{confirm.title}</DrawerTitle>
        <DrawerBody>
          {confirm.message === undefined ? null : (
            <DrawerDescription>{confirm.message}</DrawerDescription>
          )}
          {error === null ? null : (
            <div role="alert" className="text-sm text-destructive">
              <p>{error.title}</p>
              {error.description === undefined ? null : <p>{error.description}</p>}
            </div>
          )}
          <div className="flex flex-col gap-2 pt-2">
            <Button
              variant="destructive"
              className="w-full"
              disabled={pending}
              onClick={() => void runConfirmed()}
            >
              {confirm.action}
            </Button>
            <Button
              variant="ghost"
              className="h-12 w-full text-base"
              disabled={pending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}
