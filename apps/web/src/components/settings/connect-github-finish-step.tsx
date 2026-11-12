import type { ReactElement, ReactNode } from 'react'
import type { ConnectGithubWizardService, ConnectGithubWizardState } from '@reflect/app'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'

interface ConnectGithubFinishStepProps {
  state: Extract<ConnectGithubWizardState, { step: 'finish' }>
  wizard: ConnectGithubWizardService
  /**
   * `row`: desktop dialog — small buttons side by side, escape hatches
   * leading. `stack`: mobile sheet — full-width buttons, primary action
   * first (the platform's bottom-sheet convention).
   */
  layout: 'row' | 'stack'
}

/**
 * The connect wizard's finish step, shared by the desktop dialog and the
 * mobile drawer so every user-facing string lives once. Renders the finish
 * view: the public-repo consent question, the create/grant handoffs, the
 * in-flight state, or a failure with its escape back to the repo step. Only
 * button sizing/stacking varies by `layout`.
 */
export function ConnectGithubFinishStep({
  state,
  wizard,
  layout,
}: ConnectGithubFinishStepProps): ReactElement {
  const { view } = state
  const buttonSize = layout === 'row' ? ('sm' as const) : undefined
  const groupClass = layout === 'row' ? 'flex gap-2' : 'flex flex-col gap-2'

  function changeRepository(label = 'Change repository'): ReactNode {
    return (
      <Button variant="outline" size={buttonSize} onClick={wizard.backToRepo}>
        {label}
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-text-muted">
        Signed in as <strong className="text-text">{state.user.login}</strong>
      </p>

      {view.kind === 'publicConfirm' ? (
        <>
          <InlineAlert tone="error">
            <strong>
              {view.repo.owner}/{view.repo.name} is public.
            </strong>{' '}
            Anyone on the internet can read everything in this graph, including notes marked
            private.
          </InlineAlert>
          <div className={groupClass}>
            {layout === 'row' ? changeRepository('Choose another repo') : null}
            <Button variant="destructive" size={buttonSize} onClick={wizard.confirmPublic}>
              Sync with a public repo
            </Button>
            {layout === 'stack' ? changeRepository('Choose another repo') : null}
          </div>
        </>
      ) : null}

      {view.kind === 'createGuide' ? (
        <>
          <p className="text-sm text-text">
            Create{' '}
            <strong>
              {view.repo.owner}/{view.repo.name}
            </strong>{' '}
            on GitHub. Reflect will connect it as soon as it exists.
          </p>
          <div className={groupClass}>
            <Button size={buttonSize} onClick={wizard.openCreatePage}>
              Create on GitHub…
            </Button>
            {changeRepository()}
          </div>
          <p className="text-xs text-text-muted">Waiting for the repository…</p>
          {view.authKind === 'app' ? (
            <p className="text-xs text-text-muted">
              If it doesn’t connect,{' '}
              <button type="button" className="underline" onClick={wizard.openInstallPage}>
                grant the Reflect app access
              </button>{' '}
              to just this repository.
            </p>
          ) : (
            <p className="text-xs text-text-muted">
              If it doesn’t connect, add it to your token’s repository access.
            </p>
          )}
        </>
      ) : null}

      {view.kind === 'grantAccess' ? (
        <>
          <p className="text-sm text-text">
            Give Reflect access to{' '}
            <strong>
              {view.repo.owner}/{view.repo.name}
            </strong>{' '}
            so it can sync here.
          </p>
          <div className={groupClass}>
            <Button size={buttonSize} onClick={wizard.openInstallPage}>
              Grant access on GitHub…
            </Button>
            {changeRepository()}
          </div>
          {/* Steer to per-repo selection: the backup needs exactly one repo,
              so "All repositories" is needless account-wide risk. */}
          <p className="text-xs text-text-muted">
            On GitHub, choose <strong>Only select repositories</strong> — Reflect only needs this
            one.
          </p>
          <p className="text-xs text-text-muted">Waiting for access…</p>
        </>
      ) : null}

      {view.kind === 'connecting' ? <p className="text-sm text-text-muted">Connecting…</p> : null}

      {view.kind === 'failed' ? (
        <>
          <InlineAlert tone="error">{view.error}</InlineAlert>
          {changeRepository()}
        </>
      ) : null}

      {state.openError !== null ? <InlineAlert tone="error">{state.openError}</InlineAlert> : null}
    </div>
  )
}
