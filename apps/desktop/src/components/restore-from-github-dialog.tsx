import { useEffect, useState, type ReactElement } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { getGithubToken, githubRemoteUrl, gitClone, ReflectError } from '@reflect/core'
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

  // The dialog is conditionally mounted by its parent (not kept alive with
  // open=false), so Radix's Presence/onCloseAutoFocus path is bypassed when a
  // successful restore calls onClose() directly. Capturing focus here and
  // restoring it in the cleanup ensures the opener always gets focus back
  // regardless of which close path runs.
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement) {
        opener.focus()
      }
    }
  }, [])

  async function pickDestination(): Promise<void> {
    const picked = await open({ directory: true, multiple: false, title: 'Restore into folder' })
    if (typeof picked === 'string') {
      setDestination(picked)
    }
  }

  async function restore(): Promise<void> {
    const ref = parseRepoInput(repoInput)
    if (ref === null) {
      action.setError('Enter the repository as owner/name or a GitHub URL.')
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
          <GithubAuthStep onAuthed={() => setStep('repo')} />
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Backup repository</span>
              <Input
                autoFocus
                value={repoInput}
                onChange={(event) => setRepoInput(event.target.value)}
                placeholder="owner/name"
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
