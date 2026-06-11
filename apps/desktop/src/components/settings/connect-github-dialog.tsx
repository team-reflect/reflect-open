import { useEffect, useState, type ReactElement } from 'react'
import { type GithubRepoRef } from '@reflect/core'
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
import { useSync } from '@/providers/sync-provider'

interface ConnectGithubDialogProps {
  /** A suggested name for a newly created backup repo (from the graph name). */
  suggestedRepoName: string
  onClose: () => void
}

/**
 * The "Connect GitHub" modal: sign in ({@link GithubAuthStep}), then pick the
 * backup repo — create a new **private** one (the default) or connect an
 * existing one. Connecting a public repo demands explicit confirmation:
 * every note in the graph, including `private: true` ones, would be
 * world-readable.
 */
export function ConnectGithubDialog({
  suggestedRepoName,
  onClose,
}: ConnectGithubDialogProps): ReactElement {
  const { connectNewRepo, connectExistingRepo } = useSync()
  const action = useAsyncAction()
  const [step, setStep] = useState<'auth' | 'repo'>('auth')

  const [mode, setMode] = useState<'create' | 'existing'>('create')
  const [repoName, setRepoName] = useState(suggestedRepoName)
  const [existingRepo, setExistingRepo] = useState('')
  const [publicConfirm, setPublicConfirm] = useState<GithubRepoRef | null>(null)

  // The dialog is conditionally mounted by its parent (not kept alive with
  // open=false), so Radix's Presence/onCloseAutoFocus path is bypassed when a
  // successful connect calls onClose() directly. Capturing focus here and
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

  async function connect(allowPublic = false): Promise<void> {
    if (mode === 'create') {
      const name = repoName.trim()
      if (name.length === 0) {
        action.setError('Name the new repository.')
        return
      }
      await action.run(async () => {
        await connectNewRepo(name)
        onClose()
      })
      return
    }
    const ref = publicConfirm ?? parseRepoInput(existingRepo)
    if (ref === null) {
      action.setError('Enter the repository as owner/name or a GitHub URL.')
      return
    }
    await action.run(async () => {
      const result = await connectExistingRepo(ref, { allowPublic })
      if (result === 'notFound') {
        action.setError(
          'That repository was not found (check the name and the token’s repo access).',
        )
        return
      }
      if (result === 'needsPublicConfirm') {
        setPublicConfirm(ref)
        return
      }
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
          <DialogTitle>Connect GitHub</DialogTitle>
          <DialogDescription>
            Back up this graph to a GitHub repository of your own.
          </DialogDescription>
        </DialogHeader>

        {step === 'auth' ? (
          <GithubAuthStep onAuthed={() => setStep('repo')} />
        ) : (
          <div className="flex flex-col gap-3">
            {publicConfirm === null ? (
              <>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="radio"
                      checked={mode === 'create'}
                      onChange={() => setMode('create')}
                    />
                    Create a new private repository
                  </label>
                  {mode === 'create' ? (
                    <Input
                      autoFocus
                      value={repoName}
                      onChange={(event) => setRepoName(event.target.value)}
                      className="ml-6 w-auto"
                      aria-label="New repository name"
                    />
                  ) : null}
                  <label className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="radio"
                      checked={mode === 'existing'}
                      onChange={() => setMode('existing')}
                    />
                    Use an existing repository
                  </label>
                  {mode === 'existing' ? (
                    <Input
                      autoFocus
                      value={existingRepo}
                      onChange={(event) => setExistingRepo(event.target.value)}
                      placeholder="owner/name"
                      className="ml-6 w-auto"
                      aria-label="Existing repository"
                    />
                  ) : null}
                </div>
                <Button onClick={() => void connect()} disabled={action.pending} size="sm">
                  {action.pending ? 'Connecting…' : 'Connect'}
                </Button>
              </>
            ) : (
              <>
                <InlineAlert tone="error">
                  <strong>
                    {publicConfirm.owner}/{publicConfirm.name} is public.
                  </strong>{' '}
                  Everything in this graph — including notes marked private — would be readable
                  by anyone on the internet.
                </InlineAlert>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPublicConfirm(null)}>
                    Choose another repo
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void connect(true)}
                    disabled={action.pending}
                  >
                    Back up to a public repo
                  </Button>
                </div>
              </>
            )}
            {action.error !== null ? <InlineAlert tone="error">{action.error}</InlineAlert> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
