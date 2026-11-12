import { useId, type ReactElement } from 'react'
import { getIsComposing } from '@meowdown/core'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { ConnectGithubFinishStep } from '@/components/settings/connect-github-finish-step.tsx'
import { GithubAuthStep } from '@/components/settings/github-auth-step.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/mobile/scroll-drawer.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useConnectGithubWizard } from '@/hooks/use-connect-github-wizard.ts'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'
import type { ConnectGithubWizardDeps, ConnectWizardStep } from '@reflect/app'

interface ConnectGithubDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Delay between repo-existence polls on the create handoff (test hook). */
  pollIntervalMs?: number
}

const STEP_DESCRIPTIONS: Record<ConnectWizardStep, string> = {
  repo: 'Sync this graph with Reflect on your other devices through a private GitHub repository.',
  auth: 'Sign in so Reflect can sync with it.',
  finish: 'Connecting your repository…',
  connected: 'Connected.',
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The mobile "Connect GitHub" bottom sheet — a Drawer shell over
 * {@link useConnectGithubWizard} (the same state machine as desktop's
 * {@link ConnectGithubDialog}); flow changes belong in the hook, not here.
 * Offered only for the local ("This device") graph: iCloud graphs sync
 * through the container, and a Git remote and iCloud sync are mutually
 * exclusive per graph (Plan 21).
 *
 * The wizard body mounts per open cycle, so a dismissed half-finished run
 * never leaks its step/state into the next open — and unmounting also stops
 * the wizard's repo polls and the auth step's device-flow poll.
 */
export function ConnectGithubDrawer({
  open,
  onOpenChange,
  pollIntervalMs,
}: ConnectGithubDrawerProps): ReactElement {
  // Connect is offered only while the graph runs git sync, which has a connector.
  const connector = useMaybeGraphServices()?.githubConnector ?? null
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Connect GitHub">
        {open && connector !== null ? (
          <ConnectWizardSheet
            connector={connector}
            onClose={() => onOpenChange(false)}
            pollIntervalMs={pollIntervalMs}
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

/** The sheet body — separate so each open starts a fresh wizard. */
function ConnectWizardSheet({
  connector,
  onClose,
  pollIntervalMs,
}: {
  connector: ConnectGithubWizardDeps['connector']
  onClose: () => void
  pollIntervalMs?: number | undefined
}): ReactElement {
  // Never derived from the graph name: the local graph's display name is the
  // sandbox folder's basename — literally "Documents".
  const { state, wizard } = useConnectGithubWizard({
    connector,
    suggestedRepoName: 'reflect-backup',
    onConnected: onClose,
    pollIntervalMs,
  })
  const createNameId = useId()
  const existingRepoId = useId()

  return (
    <>
      <DrawerTitle>Connect GitHub</DrawerTitle>
      <DrawerBody>
        <p className="text-xs text-text-muted">{STEP_DESCRIPTIONS[state.step]}</p>

        {state.step === 'repo' ? (
          <>
            <div className="flex flex-col gap-2">
              <label className="flex min-h-11 items-center gap-3 text-[15px] text-text">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={state.mode === 'create'}
                  onChange={() => wizard.setMode('create')}
                />
                Create a new private repository
              </label>
              {state.mode === 'create' ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={createNameId} className={FIELD_LABEL_CLASS}>
                    Repository name
                  </label>
                  <Input
                    id={createNameId}
                    value={state.repoName}
                    enterKeyHint="go"
                    onChange={(event) => wizard.setRepoName(event.target.value)}
                    onKeyDown={(event) => {
                      if (getIsComposing()) {
                        return
                      }
                      if (event.key === 'Enter') {
                        wizard.continueFromRepo()
                      }
                    }}
                  />
                </div>
              ) : null}
              <label className="flex min-h-11 items-center gap-3 text-[15px] text-text">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={state.mode === 'existing'}
                  onChange={() => wizard.setMode('existing')}
                />
                Use an existing repository
              </label>
              {state.mode === 'existing' ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={existingRepoId} className={FIELD_LABEL_CLASS}>
                    Repository
                  </label>
                  <Input
                    id={existingRepoId}
                    value={state.existingRepo}
                    placeholder="owner/name"
                    autoCapitalize="none"
                    autoCorrect="off"
                    enterKeyHint="go"
                    onChange={(event) => wizard.setExistingRepo(event.target.value)}
                    onKeyDown={(event) => {
                      if (getIsComposing()) {
                        return
                      }
                      if (event.key === 'Enter') {
                        wizard.continueFromRepo()
                      }
                    }}
                  />
                </div>
              ) : null}
            </div>
            <Button onClick={wizard.continueFromRepo}>Continue</Button>
          </>
        ) : null}

        {state.step === 'auth' ? (
          <GithubAuthStep
            onAuthed={wizard.onAuthed}
            repoName={state.choice.kind === 'create' ? state.choice.name : undefined}
          />
        ) : null}

        {state.step === 'finish' ? (
          <ConnectGithubFinishStep state={state} wizard={wizard} layout="stack" />
        ) : null}

        {state.step === 'repo' && state.error !== null ? (
          <InlineAlert tone="error">{state.error}</InlineAlert>
        ) : null}
      </DrawerBody>
    </>
  )
}
