import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The machine-level "Sign out of GitHub" button behind a confirmation
 * dialog. Clearing the sign-in restarts every graph's git sync by itself, so
 * this touches no graph.
 */
export function GithubSignOutRow(): ReactElement {
  const { githubAuth } = useCoreServices()
  const [open, setOpen] = useState(false)
  const action = useAsyncAction()

  function setDialogOpen(next: boolean): void {
    if (!next && action.pending) {
      return
    }
    setOpen(next)
  }

  async function confirmSignOut(): Promise<void> {
    await action.run(async () => {
      await githubAuth.clear()
      setOpen(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            title="Removes the GitHub token from this machine"
            disabled={action.pending}
          >
            Sign out of GitHub…
          </Button>
        }
      />
      <DialogContent showCloseButton={!action.pending}>
        <DialogHeader>
          <DialogTitle>Sign out of GitHub?</DialogTitle>
          <DialogDescription>
            This removes the GitHub token from this machine. Every graph that syncs with a GitHub
            repository stops until you sign in again, and notes can no longer be shared as gists.
          </DialogDescription>
        </DialogHeader>
        {action.error !== null ? (
          <p className="text-xs text-red-700 dark:text-red-300">{action.error}</p>
        ) : null}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" disabled={action.pending}>
                Cancel
              </Button>
            }
          />
          <Button
            variant="destructive"
            disabled={action.pending}
            onClick={() => void confirmSignOut()}
          >
            Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
