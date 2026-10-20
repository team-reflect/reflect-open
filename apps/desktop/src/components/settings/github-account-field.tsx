import { useState, type ReactElement } from 'react'
import { SettingsField } from '@/components/settings/field.tsx'
import { GithubSignInDialog } from '@/components/settings/github-sign-in-dialog.tsx'
import { GithubSignOutRow } from '@/components/settings/github-sign-out-row.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useGithubConnected } from '@/hooks/use-github-connected.ts'

/**
 * Settings → Sync → GitHub account: the one GitHub sign-in of this machine.
 * It serves GitHub repositories and gist publishing, and never depends on
 * whether the open graph syncs. Signing in here resumes every GitHub
 * repository that was waiting for it; signing out stops them.
 */
export function GithubAccountField(): ReactElement {
  const connected = useGithubConnected()
  const [signInOpen, setSignInOpen] = useState(false)

  return (
    <>
      <SettingsField
        legend="GitHub account"
        description={
          connected
            ? 'Signed in. Used for GitHub repositories and for sharing notes as gists.'
            : 'Sign in to sync with a GitHub repository or to share notes as gists.'
        }
      >
        <div className="mt-3">
          {connected ? (
            <GithubSignOutRow />
          ) : (
            <Button size="sm" onClick={() => setSignInOpen(true)}>
              Sign in to GitHub…
            </Button>
          )}
        </div>
      </SettingsField>
      {signInOpen ? <GithubSignInDialog onClose={() => setSignInOpen(false)} /> : null}
    </>
  )
}
