import { useEffect, useState, type ReactElement } from 'react'
import { FormProvider } from 'react-hook-form'
import { ConnectGitHostFields } from '@/components/settings/connect-git-host-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'
import { useConnectGitHostForm } from '@/hooks/use-connect-git-host-form.ts'

interface ConnectGitHostDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The remote to prefill: an HTTPS remote that needs a sign-in. */
  remoteUrl?: string | undefined
}

/**
 * The mobile "Other host" bottom sheet: a Drawer shell over
 * {@link useConnectGitHostForm}, the same form as desktop's dialog. The body
 * mounts per open cycle, so a dismissed half-filled form never leaks into
 * the next.
 */
export function ConnectGitHostDrawer({
  open,
  onOpenChange,
  remoteUrl,
}: ConnectGitHostDrawerProps): ReactElement {
  // A swipe cannot dismiss the sheet while the host is being asked.
  const [pending, setPending] = useState(false)
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (next || !pending) {
          onOpenChange(next)
        }
      }}
    >
      <DrawerContent aria-label="Other host">
        {open ? (
          <ConnectGitHostSheet
            remoteUrl={remoteUrl}
            onClose={() => onOpenChange(false)}
            onPendingChange={setPending}
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function ConnectGitHostSheet({
  remoteUrl,
  onClose,
  onPendingChange,
}: {
  remoteUrl: string | undefined
  onClose: () => void
  onPendingChange: (pending: boolean) => void
}): ReactElement {
  const { form, submit } = useConnectGitHostForm({ remoteUrl, onDone: onClose })
  const pending = form.formState.isSubmitting
  const updating = remoteUrl !== undefined
  useEffect(() => {
    onPendingChange(pending)
  }, [pending, onPendingChange])

  return (
    <>
      <DrawerTitle>{updating ? 'Update sign-in' : 'Other host'}</DrawerTitle>
      <DrawerBody>
        <FormProvider {...form}>
          <ConnectGitHostFields
            onSubmit={submit}
            updating={updating}
            actions={({ pending, canSubmit }) => (
              <Button type="submit" disabled={!canSubmit}>
                {updating
                  ? pending
                    ? 'Updating…'
                    : 'Update sign-in'
                  : pending
                    ? 'Connecting…'
                    : 'Connect'}
              </Button>
            )}
          />
        </FormProvider>
      </DrawerBody>
    </>
  )
}
