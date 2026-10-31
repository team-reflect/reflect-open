import { useCallback, useState, type ReactElement } from 'react'
import { ConfirmActionDialog } from '@/components/confirm-action-dialog.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The machine-level "Sign out of GitHub" button behind a confirmation
 * dialog. Clearing the sign-in restarts every graph's git sync by itself, so
 * this touches no graph.
 */
export function GithubSignOutRow(): ReactElement {
  const { githubAuth } = useCoreServices()
  const [open, setOpen] = useState(false)
  const signOut = useCallback(() => githubAuth.clear(), [githubAuth])
  const close = useCallback(() => setOpen(false), [])

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        title="Removes the GitHub token from this machine"
        onClick={() => setOpen(true)}
      >
        Sign out of GitHub…
      </Button>
      {open ? (
        <ConfirmActionDialog
          title="Sign out of GitHub?"
          description="This removes the GitHub token from this machine. Every graph that syncs with a GitHub repository stops until you sign in again, and notes can no longer be shared as gists."
          confirmLabel="Sign out"
          pendingLabel="Signing out…"
          variant="destructive"
          onConfirm={signOut}
          onClose={close}
        />
      ) : null}
    </>
  )
}
