import type { ReactElement } from 'react'
import { GithubAuthStep } from '@/components/settings/github-auth-step.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'

interface GithubSignInDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The mobile "Sign in to GitHub" bottom sheet: the connect wizard's own
 * sign-in step on its own, for a GitHub remote whose sign-in is gone. It
 * closes once GitHub has confirmed the credential. The body mounts per open
 * cycle so a dismissed device flow stops polling.
 */
export function GithubSignInDrawer({ open, onOpenChange }: GithubSignInDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Sign in to GitHub">
        {open ? (
          <>
            <DrawerTitle>Sign in to GitHub</DrawerTitle>
            <DrawerBody>
              <p className="text-xs text-text-muted">
                This graph resumes backing up to its repository once you are signed in.
              </p>
              <GithubAuthStep onAuthed={() => onOpenChange(false)} />
            </DrawerBody>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}
