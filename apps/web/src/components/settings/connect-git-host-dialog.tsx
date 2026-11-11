import type { ReactElement } from 'react'
import { FormProvider } from 'react-hook-form'
import { ConnectGitHostFields } from '@/components/settings/connect-git-host-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { useConnectGitHostForm } from '@/hooks/use-connect-git-host-form.ts'

interface ConnectGitHostDialogProps {
  /**
   * The remote to prefill: an HTTPS remote that needs a sign-in. Empty for
   * a new connection.
   */
  remoteUrl?: string | undefined
  onClose: () => void
}

/**
 * The desktop "Other host" dialog: connect this graph to a repository on any
 * https git host with a username and an access token or password. The host
 * answers before anything is stored, so a wrong address or sign-in fails
 * here, inline.
 */
export function ConnectGitHostDialog({
  remoteUrl,
  onClose,
}: ConnectGitHostDialogProps): ReactElement {
  const { form, submit } = useConnectGitHostForm({ remoteUrl, onDone: onClose })
  const pending = form.formState.isSubmitting
  const updating = remoteUrl !== undefined

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen && !pending) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={!pending} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{updating ? 'Update sign-in' : 'Other host'}</DialogTitle>
        </DialogHeader>
        <FormProvider {...form}>
          <ConnectGitHostFields
            onSubmit={submit}
            updating={updating}
            actions={({ pending, canSubmit }) => (
              <DialogFooter>
                <DialogClose
                  render={
                    <Button type="button" variant="ghost" size="sm" disabled={pending}>
                      Cancel
                    </Button>
                  }
                />
                <Button type="submit" size="sm" disabled={!canSubmit}>
                  {updating
                    ? pending
                      ? 'Updating…'
                      : 'Update sign-in'
                    : pending
                      ? 'Connecting…'
                      : 'Connect'}
                </Button>
              </DialogFooter>
            )}
          />
        </FormProvider>
      </DialogContent>
    </Dialog>
  )
}
