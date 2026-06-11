import { useState, type ReactElement } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  getGithubToken,
  githubRemoteUrl,
  gitClone,
  ReflectError,
  type GithubUser,
} from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { GithubAuthStep } from '@/components/settings/github-auth-step'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAsyncAction } from '@/hooks/use-async-action'
import { useRestoreFocus } from '@/hooks/use-restore-focus'
import { parseRepoInput } from '@/lib/github-repos'
import { providerFetch } from '@/lib/provider-fetch'
import { useGraph } from '@/providers/graph-provider'

interface RestoreFromGithubDialogProps {
  onClose: () => void
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * Restore a backed-up graph on a fresh machine (Plan 12 acceptance): sign in
 * ({@link GithubAuthStep}), name the backup repo, choose where to put it, and
 * clone. The clone lands in `<chosen folder>/<repo name>` — `git_clone`
 * refuses non-empty destinations, so a restore can never overwrite existing
 * notes — and the result opens as a normal graph (the index rebuilds from
 * the files, Plan 04).
 */
export function RestoreFromGithubDialog({ onClose }: RestoreFromGithubDialogProps): ReactElement {
  const { openRecent } = useGraph()
  const action = useAsyncAction()
  const [step, setStep] = useState<'auth' | 'repo'>('auth')
  const [repoInput, setRepoInput] = useState('')
  const [destination, setDestination] = useState<string | null>(null)
  const [user, setUser] = useState<GithubUser | null>(null)

  useRestoreFocus()

  async function pickDestination(): Promise<void> {
    const picked = await open({ directory: true, multiple: false, title: 'Restore into folder' })
    if (typeof picked === 'string') {
      setDestination(picked)
    }
  }

  async function restore(): Promise<void> {
    // A bare name belongs to the signed-in account — the common case never
    // needs the owner typed. Normalize first so both spellings go through
    // the same validation instead of failing later at the clone.
    const trimmed = repoInput.trim()
    const normalized =
      !trimmed.includes('/') && trimmed.length > 0 && user !== null
        ? `${user.login}/${trimmed}`
        : trimmed
    const ref = parseRepoInput(normalized)
    if (ref === null) {
      action.setError('Enter the repository name (or owner/name for another account).')
      return
    }
    if (destination === null) {
      action.setError('Choose a folder to restore into.')
      return
    }
    await action.run(async () => {
      const token = await getGithubToken(providerFetch)
      if (token === null) {
        throw new ReflectError('auth', 'Sign in to GitHub first')
      }
      const target = `${destination}/${ref.name}`
      await gitClone(githubRemoteUrl(ref), target, token)
      await openRecent(target) // opens the clone as a graph; the index rebuilds
      onClose()
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Restore from GitHub</DialogTitle>
          <DialogDescription>
            Download a graph you backed up from another device.
          </DialogDescription>
        </DialogHeader>

        {step === 'auth' ? (
          <GithubAuthStep
            onAuthed={(authedUser) => {
              setUser(authedUser)
              setStep('repo')
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Backup repository</span>
              <Input
                autoFocus
                value={repoInput}
                onChange={(event) => setRepoInput(event.target.value)}
                placeholder={user !== null ? `${user.login}/…` : 'owner/name'}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void pickDestination()}>
                Restore into…
              </Button>
              <span className="min-w-0 truncate text-xs text-text-muted">
                {destination ?? 'No folder chosen'}
              </span>
            </div>
            <Button onClick={() => void restore()} disabled={action.pending} size="sm">
              {action.pending ? 'Restoring…' : 'Restore'}
            </Button>
            {action.error !== null ? <InlineAlert tone="error">{action.error}</InlineAlert> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
