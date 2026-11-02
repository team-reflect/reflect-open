import { useMemo } from 'react'
import type { MobileOnboardingState } from '@reflect/app'
import type { MobileStorageInfo, MobileStorageKind } from '@reflect/core'
import { useSelector } from '@/lib/use-store.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The mobile-only graph state, read from `MobileOnboardingService`.
 */
export interface MobileGraphBoot {
  /**
   * The user hasn't yet chosen where their notes live (Plan 19, step 6), so
   * both fixed roots are left untouched and the onboarding screen shows
   * instead of the graph. Always false on desktop.
   */
  needsOnboarding: boolean
  /**
   * The storage roots available to the graph (Plan 21), derived fresh at
   * bootstrap (null elsewhere). Paths must never be persisted — iOS
   * container paths change across restore/update. On a fresh install this is
   * seeded with the sandbox root alone (available instantly) while the
   * iCloud container resolves — see {@link mobileStorageResolving}.
   */
  mobileStorageInfo: MobileStorageInfo | null
  /**
   * True while the iCloud container is still resolving (the first
   * `URLForUbiquityContainerIdentifier` call on a fresh install can take a
   * long time). Onboarding shows the iCloud section as pending rather than
   * hiding it — a null `icloudDocumentsRoot` alone would read as "signed
   * out".
   */
  mobileStorageResolving: boolean
  /**
   * Which root the open graph lives in — `'icloud'` for the iCloud Drive
   * container, `'local'` for the app sandbox. Null until a graph is open
   * (and always null on desktop). The iCloud foreground refresh keys off
   * this.
   */
  mobileStorageKind: MobileStorageKind | null
  /**
   * Open a storage choice and persist it (onboarded flag, storage kind, and
   * — for iCloud — the graph *name*, since the container can hold several
   * graphs). Used by onboarding to finish, and by the settings graph
   * switcher to move between graphs. `root` selects a specific container
   * graph (or a fresh directory to create); omitted, the kind's default
   * root opens.
   */
  completeOnboarding: (kind: MobileStorageKind, root?: string) => Promise<void>
}

function selectNeedsOnboarding(state: MobileOnboardingState): boolean {
  return state.needsOnboarding
}

function selectStorageInfo(state: MobileOnboardingState): MobileStorageInfo | null {
  return state.storageInfo
}

function selectResolving(state: MobileOnboardingState): boolean {
  return state.resolving
}

function selectKind(state: MobileOnboardingState): MobileStorageKind | null {
  return state.kind
}

/**
 * The mobile graph bootstrap (Plans 19/21): the state of the
 * `MobileOnboardingService` that `GraphProvider` boots. Inert on desktop.
 */
export function useMobileGraphBoot(): MobileGraphBoot {
  const { mobileOnboarding: service } = useAppServices()
  const needsOnboarding = useSelector(service, selectNeedsOnboarding)
  const mobileStorageInfo = useSelector(service, selectStorageInfo)
  const mobileStorageResolving = useSelector(service, selectResolving)
  const mobileStorageKind = useSelector(service, selectKind)

  return useMemo(
    () => ({
      needsOnboarding,
      mobileStorageInfo,
      mobileStorageResolving,
      mobileStorageKind,
      completeOnboarding: (...args) => service.completeOnboarding(...args),
    }),
    [needsOnboarding, mobileStorageInfo, mobileStorageResolving, mobileStorageKind, service],
  )
}
