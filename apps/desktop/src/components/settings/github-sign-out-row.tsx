import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useAsyncAction } from '@/hooks/use-async-action'

interface GithubSignOutRowProps {
  /** Remove the machine's GitHub credential (every connected graph stops syncing). */
  signOut: () => Promise<void>
  /** The one-line explanation shown beside the button, tuned to the caller. */
  description: string
}

/**
 * The machine-level "Sign out of GitHub" row: a destructive button behind a
 * confirmation dialog, with a short explanation. GitHub sign-in is per machine,
 * not per graph, so this is reused wherever the stored credential can be
 * reached: beside a connected repo, and (with no connected graph) on its own,
 * so the credential can still be cleared to switch to another account.
 */
export function GithubSignOutRow({ signOut, description }: GithubSignOutRowProps): ReactElement {
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
      await signOut()
      setOpen(false)
    })
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border/70 pt-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-xs font-medium text-text">GitHub account</p>
        <p className="text-xs text-text-muted">{description}</p>
      </div>
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild>
          <Button
            variant="destructive"
            size="sm"
            title="Removes the GitHub token from this machine"
            disabled={action.pending}
          >
            Sign out of GitHub…
          </Button>
        </DialogTrigger>
        <DialogContent showCloseButton={!action.pending}>
          <DialogHeader>
            <DialogTitle>Sign out of GitHub?</DialogTitle>
            <DialogDescription>
              This removes the GitHub token from this machine. Every
              GitHub-backed graph will stop backing up until you sign in again.
            </DialogDescription>
          </DialogHeader>
          {action.error !== null ? (
            <p className="text-xs text-red-700 dark:text-red-300">{action.error}</p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={action.pending}>
                Cancel
              </Button>
            </DialogClose>
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
    </div>
  )
}
