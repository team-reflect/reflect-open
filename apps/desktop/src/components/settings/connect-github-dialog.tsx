import { type ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert'
import { ConnectGithubFinishStep } from '@/components/settings/connect-github-finish-step'
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
import { useConnectGithubWizard, type ConnectWizardStep } from '@/hooks/use-connect-github-wizard'
import { useRestoreFocus } from '@/hooks/use-restore-focus'

interface ConnectGithubDialogProps {
  /** A suggested name for a newly created backup repo (from the graph name). */
  suggestedRepoName: string
  onClose: () => void
  /** Delay between repo-existence polls on the create handoff (test hook). */
  pollIntervalMs?: number
}

const STEP_DESCRIPTIONS: Record<ConnectWizardStep, string> = {
  repo: 'Back up this graph to a private GitHub repository.',
  auth: 'Sign in so Reflect can push your backups.',
  finish: 'Connecting your repository…',
}

/**
 * The desktop "Connect GitHub" dialog — a Dialog shell over
 * {@link useConnectGithubWizard}, which owns the whole flow (repo → sign-in →
 * connect, with the create-handoff/grant-access polls and the public-repo
 * consent gate). The mobile drawer renders the same hook; flow changes belong
 * there, not here.
 */
export function ConnectGithubDialog({
  suggestedRepoName,
  onClose,
  pollIntervalMs = 3000,
}: ConnectGithubDialogProps): ReactElement {
  const wizard = useConnectGithubWizard({ suggestedRepoName, onClose, pollIntervalMs })

  useRestoreFocus()

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
          <DialogDescription>{STEP_DESCRIPTIONS[wizard.step]}</DialogDescription>
        </DialogHeader>

        {wizard.step === 'repo' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={wizard.mode === 'create'}
                  onChange={() => wizard.setMode('create')}
                />
                Create a new private repository
              </label>
              {wizard.mode === 'create' ? (
                <Input
                  autoFocus
                  value={wizard.repoName}
                  onChange={(event) => wizard.setRepoName(event.target.value)}
                  className="ml-6 w-auto"
                  aria-label="New repository name"
                />
              ) : null}
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={wizard.mode === 'existing'}
                  onChange={() => wizard.setMode('existing')}
                />
                Use an existing repository
              </label>
              {wizard.mode === 'existing' ? (
                <Input
                  autoFocus
                  value={wizard.existingRepo}
                  onChange={(event) => wizard.setExistingRepo(event.target.value)}
                  placeholder="owner/name"
                  className="ml-6 w-auto"
                  aria-label="Existing repository"
                />
              ) : null}
            </div>
            <Button onClick={wizard.continueFromRepo} size="sm">
              Continue
            </Button>
          </div>
        ) : null}

        {wizard.step === 'auth' ? (
          <GithubAuthStep
            onAuthed={wizard.onAuthed}
            repoName={wizard.mode === 'create' ? wizard.repoName.trim() : undefined}
          />
        ) : null}

        {wizard.step === 'finish' ? (
          <ConnectGithubFinishStep wizard={wizard} layout="row" />
        ) : null}

        {wizard.step !== 'finish' && wizard.error !== null ? (
          <InlineAlert tone="error">{wizard.error}</InlineAlert>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
