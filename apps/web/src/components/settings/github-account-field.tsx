import { useEffect, useRef, useState, type ReactElement } from 'react'
import { SettingsField } from '@/components/settings/field.tsx'
import { GithubSignInDialog } from '@/components/settings/github-sign-in-dialog.tsx'
import { GithubSignOutRow } from '@/components/settings/github-sign-out-row.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useGithubConnected } from '@/hooks/use-github-connected.ts'

/**
 * Settings → Accounts → GitHub: the one GitHub sign-in of this machine.
 * It serves GitHub repositories and gist publishing, and never depends on
 * whether the open graph syncs. Signing in here resumes every GitHub
 * repository that was waiting for it; signing out stops them.
 */
export function GithubAccountField(): ReactElement {
  const connected = useGithubConnected()
  const [signInOpen, setSignInOpen] = useState(false)
  const signInButtonRef = useRef<HTMLButtonElement>(null)
  const wasConnectedRef = useRef(connected)

  // Signing out unmounts the focused sign-out button and its dialog, so
  // keyboard focus would land on the body; hand it to the button that took
  // their place.
  useEffect(() => {
    if (wasConnectedRef.current && !connected) {
      signInButtonRef.current?.focus()
    }
    wasConnectedRef.current = connected
  }, [connected])

  return (
    <>
      <SettingsField
        legend="GitHub"
        description={
          connected
            ? 'Signed in. Used for GitHub repositories and for sharing notes as gists.'
            : 'Sign in to connect a GitHub repository or to share notes as gists.'
        }
      >
        <div className="mt-3">
          {connected ? (
            <GithubSignOutRow />
          ) : (
            <Button ref={signInButtonRef} size="sm" onClick={() => setSignInOpen(true)}>
              Sign in to GitHub…
            </Button>
          )}
        </div>
      </SettingsField>
      {signInOpen ? <GithubSignInDialog onClose={() => setSignInOpen(false)} /> : null}
    </>
  )
}
