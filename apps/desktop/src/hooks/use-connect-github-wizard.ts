import { useEffect, useState } from 'react'
import {
  createConnectGithubWizardService,
  type ConnectGithubWizardDeps,
  type ConnectGithubWizardOptions,
  type ConnectGithubWizardService,
  type ConnectGithubWizardState,
} from '@reflect/app'
import { useStore } from '@/lib/use-store.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

export interface UseConnectGithubWizardOptions extends ConnectGithubWizardOptions {
  /**
   * The open graph's GitHub connector. A new connector starts a new wizard.
   */
  connector: ConnectGithubWizardDeps['connector']
  /**
   * Called once the repository is connected (the surface dismisses itself).
   */
  onConnected: () => void
}

/**
 * The "Connect GitHub" wizard for one mounted surface: a thin React shell
 * over app's `ConnectGithubWizardService`, which owns the whole flow.
 * Desktop's dialog and mobile's drawer drive the same flow through it.
 */
export function useConnectGithubWizard({
  connector,
  suggestedRepoName,
  onConnected,
  pollIntervalMs = 3000,
}: UseConnectGithubWizardOptions): {
  state: ConnectGithubWizardState
  wizard: ConnectGithubWizardService
} {
  const { githubAuth, clock } = useCoreServices()
  const { opener, lifecycle } = useAppServices()
  const createWizard = (): ConnectGithubWizardService => {
    return createConnectGithubWizardService(
      { connector, githubAuth, opener, lifecycle, clock },
      { suggestedRepoName, pollIntervalMs },
    )
  }
  const [entry, setEntry] = useState(() => ({ connector, wizard: createWizard() }))
  if (entry.connector !== connector) {
    setEntry({ connector, wizard: createWizard() })
  }
  const { wizard } = entry

  useEffect(() => wizard.attach(), [wizard])

  const state = useStore(wizard)

  useEffect(() => {
    if (state.step === 'connected') {
      onConnected()
    }
  }, [state.step, onConnected])

  return { state, wizard }
}
