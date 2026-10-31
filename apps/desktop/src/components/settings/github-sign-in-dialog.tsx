import type { ReactElement } from 'react'
import { GithubAuthStep } from '@/components/settings/github-auth-step.tsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'

interface GithubSignInDialogProps {
  onClose: () => void
}

/**
 * Sign in to GitHub on its own, without connecting a repository. The stored
 * sign-in serves every GitHub repository this machine syncs and the gist
 * publishing of every graph. The step is the connect wizard's own; it closes
 * once GitHub has confirmed the credential.
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
        </DialogHeader>
        <GithubAuthStep onAuthed={onClose} />
      </DialogContent>
    </Dialog>
  )
}
