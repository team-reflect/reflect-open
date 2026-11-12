import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { ConnectGithubFinishStep } from '@/components/settings/connect-github-finish-step.tsx'
import { GithubAuthStep } from '@/components/settings/github-auth-step.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useConnectGithubWizard } from '@/hooks/use-connect-github-wizard.ts'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'
import type { ConnectGithubWizardDeps, ConnectWizardStep } from '@reflect/app'

interface ConnectGithubDialogProps {
  /** A suggested name for a newly created backup repo (from the graph name). */
  suggestedRepoName: string
  onClose: () => void
  /** Delay between repo-existence polls on the create handoff (test hook). */
  pollIntervalMs?: number
}

const STEP_DESCRIPTIONS: Record<ConnectWizardStep, string> = {
  repo: 'Sync this graph through a private GitHub repository.',
  auth: 'Sign in so Reflect can sync with it.',
  finish: 'Connecting your repository…',
  connected: 'Connected.',
}

/**
 * The desktop "Connect GitHub" dialog — a Dialog shell over
 * {@link useConnectGithubWizard}, which owns the whole flow (repo → sign-in →
 * connect, with the create-handoff/grant-access polls and the public-repo
 * consent gate). The mobile drawer renders the same hook; flow changes belong
 * there, not here.
 */
export function ConnectGithubDialog(props: ConnectGithubDialogProps): ReactElement | null {
  // Connect is offered only while the graph runs git sync, which has a connector.
  const connector = useMaybeGraphServices()?.githubConnector ?? null
  return connector === null ? null : <ConnectGithubDialogContent {...props} connector={connector} />
}

function ConnectGithubDialogContent({
  connector,
  suggestedRepoName,
  onClose,
  pollIntervalMs = 3000,
}: ConnectGithubDialogProps & {
  connector: ConnectGithubWizardDeps['connector']
}): ReactElement {
  const { state, wizard } = useConnectGithubWizard({
    connector,
    suggestedRepoName,
    onConnected: onClose,
    pollIntervalMs,
  })

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
          <DialogDescription>{STEP_DESCRIPTIONS[state.step]}</DialogDescription>
        </DialogHeader>

        {state.step === 'repo' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={state.mode === 'create'}
                  onChange={() => wizard.setMode('create')}
                />
                Create a new private repository
              </label>
              {state.mode === 'create' ? (
                <Input
                  autoFocus
                  value={state.repoName}
                  onChange={(event) => wizard.setRepoName(event.target.value)}
                  className="ml-6 w-auto"
                  aria-label="New repository name"
                />
              ) : null}
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={state.mode === 'existing'}
                  onChange={() => wizard.setMode('existing')}
                />
                Use an existing repository
              </label>
              {state.mode === 'existing' ? (
                <Input
                  autoFocus
                  value={state.existingRepo}
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

        {state.step === 'auth' ? (
          <GithubAuthStep
            onAuthed={wizard.onAuthed}
            repoName={state.choice.kind === 'create' ? state.choice.name : undefined}
          />
        ) : null}

        {state.step === 'finish' ? (
          <ConnectGithubFinishStep state={state} wizard={wizard} layout="row" />
        ) : null}

        {state.step === 'repo' && state.error !== null ? (
          <InlineAlert tone="error">{state.error}</InlineAlert>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
