import type { ReactElement } from 'react'
import { GithubAuthStep } from '@/components/settings/github-auth-step.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'

interface GithubSignInDialogProps {
  onClose: () => void
}

/**
 * Sign in to GitHub without connecting a backup repository. The connect
 * wizard is repository-first, so a graph that syncs through iCloud or a
 * hand-wired remote had no way to store the credential that GitHub-only
 * affordances (publishing a note as a gist) gate on (#1375). The auth step is
 * the wizard's own; it stores the credential and refreshes
 * `useGithubConnected`.
 */
export function GithubSignInDialog({ onClose }: GithubSignInDialogProps): ReactElement {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in to GitHub</DialogTitle>
          <DialogDescription>
            For publishing notes as gists. This does not back up the graph; use Connect GitHub for
            that.
          </DialogDescription>
        </DialogHeader>
        <GithubAuthStep onAuthed={onClose} />
      </DialogContent>
    </Dialog>
  )
}
