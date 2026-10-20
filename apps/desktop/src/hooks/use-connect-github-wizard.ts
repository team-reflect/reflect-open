import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createConnectGithubWizardService,
  type ConnectAuthKind,
  type ConnectFinishView,
  type ConnectGithubWizardOptions,
  type ConnectWizardStep,
} from '@reflect/app'
import type { GithubUser } from '@reflect/core'
import { useGitSync } from '@/providers/sync-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

export type {
  ConnectAuthKind,
  ConnectFinishView,
  ConnectGithubWizardOptions,
  ConnectWizardStep,
} from '@reflect/app'
import { useServiceState } from '@/services/use-service-state.ts'

export interface ConnectGithubWizard {
  step: ConnectWizardStep
  mode: 'create' | 'existing'
  setMode: (mode: 'create' | 'existing') => void
  repoName: string
  setRepoName: (name: string) => void
  existingRepo: string
  setExistingRepo: (value: string) => void
  /**
   * The verified sign-in shown on the finish step; null before auth.
   */
  user: GithubUser | null
  authKind: ConnectAuthKind
  /**
   * The finish step's current view — shells render it, never re-derive it.
   */
  finishView: ConnectFinishView
  pending: boolean
  error: string | null
  /**
   * Validate the repo step and advance to sign-in.
   */
  continueFromRepo: () => void
  /**
   * Wire to {@link GithubAuthStep}'s `onAuthed` — advances and connects.
   */
  onAuthed: (user: GithubUser) => void
  /**
   * The public-repo consent button: retry the connect with consent given.
   */
  confirmPublic: () => void
  /**
   * Back to the repo step — every finish-step dead end must offer this.
   */
  backToRepo: () => void
  /**
   * Open the prefilled github.com/new page for the chosen name.
   */
  openCreatePage: () => void
  /**
   * Open the GitHub App installation page (grant repository access).
   */
  openInstallPage: () => void
}

/**
 * The "Connect GitHub" wizard for one mounted surface: a thin React shell
 * over app's `ConnectGithubWizardService`, which owns the whole state
 * machine (repo → sign-in → connect, with the create-handoff/grant-access
 * polls and the public-repo consent gate). Desktop's dialog and mobile's
 * drawer drive the identical flow through it.
 *
 * The connect actions are the ones of {@link useGitSync}.
 */
export function useConnectGithubWizard({
  suggestedRepoName,
  onClose,
  pollIntervalMs = 3000,
}: ConnectGithubWizardOptions): ConnectGithubWizard {
  const sync = useGitSync()
  const { githubAuth, clock } = useCoreServices()
  const { opener, lifecycle } = useAppServices()
  // The wizard lives as long as the surface; it always calls the latest
  // actions and `onClose` without being rebuilt every render.
  const latestRef = useRef({ sync, onClose })
  useEffect(() => {
    latestRef.current = { sync, onClose }
  })

  const [wizard] = useState(() => {
    return createConnectGithubWizardService(
      {
        connect: {
          connectNewRepo: (name) => latestRef.current.sync.connectNewRepo(name),
          connectExistingRepo: (ref, options) => {
            return latestRef.current.sync.connectExistingRepo(ref, options)
          },
        },
        githubAuth,
        opener,
        lifecycle,
        clock,
      },
      { suggestedRepoName, onClose: () => latestRef.current.onClose(), pollIntervalMs },
    )
  })

  // The repo-existence poll only runs while the surface is mounted.
  useEffect(() => wizard.attach(), [wizard])

  const state = useServiceState(wizard, wizard.getState)

  const actions = useMemo(
    () => ({
      setMode: (mode: 'create' | 'existing') => wizard.setMode(mode),
      setRepoName: (name: string) => wizard.setRepoName(name),
      setExistingRepo: (value: string) => wizard.setExistingRepo(value),
      continueFromRepo: () => wizard.continueFromRepo(),
      onAuthed: (user: GithubUser) => wizard.onAuthed(user),
      confirmPublic: () => wizard.confirmPublic(),
      backToRepo: () => wizard.backToRepo(),
      openCreatePage: () => wizard.openCreatePage(),
      openInstallPage: () => wizard.openInstallPage(),
    }),
    [wizard],
  )

  return {
    step: state.step,
    mode: state.mode,
    setMode: actions.setMode,
    repoName: state.repoName,
    setRepoName: actions.setRepoName,
    existingRepo: state.existingRepo,
    setExistingRepo: actions.setExistingRepo,
    user: state.user,
    authKind: state.authKind,
    finishView: state.finishView,
    pending: state.pending,
    error: state.error,
    continueFromRepo: actions.continueFromRepo,
    onAuthed: actions.onAuthed,
    confirmPublic: actions.confirmPublic,
    backToRepo: actions.backToRepo,
    openCreatePage: actions.openCreatePage,
    openInstallPage: actions.openInstallPage,
  }
}
