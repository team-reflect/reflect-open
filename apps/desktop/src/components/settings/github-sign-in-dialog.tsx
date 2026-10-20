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
 * Sign in to GitHub on its own, without connecting a repository: the fix for
 * a GitHub remote whose sign-in is gone. The step is the connect wizard's
 * own; the stored sign-in restarts every graph that waits for it, and the
 * dialog closes once GitHub has confirmed the credential.
 */
export function GithubSignInDialog({ onClose }: GithubSignInDialogProps): ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in to GitHub</DialogTitle>
          <DialogDescription>
            This graph resumes backing up to its repository once you are signed in.
          </DialogDescription>
        </DialogHeader>
        <GithubAuthStep onAuthed={onClose} />
      </DialogContent>
    </Dialog>
  )
}
