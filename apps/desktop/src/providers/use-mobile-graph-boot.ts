import type { MobileOnboardingState } from '@reflect/app'
import type { MobileStorageInfo, MobileStorageKind } from '@reflect/core'
import { useSelector } from '@/lib/use-store.ts'
import { useAppServices } from '@/services/services-provider.tsx'

function useMobileOnboardingSelector<T>(selector: (state: MobileOnboardingState) => T): T {
  const { mobileOnboarding } = useAppServices()
  return useSelector(mobileOnboarding, selector)
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
 * The user hasn't yet chosen where their notes live (Plan 19, step 6), so
 * both fixed roots are left untouched and the onboarding screen shows
 * instead of the graph. Always false on desktop.
 */
export function useNeedsOnboarding(): boolean {
  return useMobileOnboardingSelector(selectNeedsOnboarding)
}

/**
 * The storage roots available to the graph (Plan 21), derived fresh at
 * bootstrap (null elsewhere). Paths must never be persisted — iOS
 * container paths change across restore/update. On a fresh install this is
 * seeded with the sandbox root alone (available instantly) while the
 * iCloud container resolves — see {@link useMobileStorageResolving}.
 */
export function useMobileStorageInfo(): MobileStorageInfo | null {
  return useMobileOnboardingSelector(selectStorageInfo)
}

/**
 * True while the iCloud container is still resolving (the first
 * `URLForUbiquityContainerIdentifier` call on a fresh install can take a
 * long time). Onboarding shows the iCloud section as pending rather than
 * hiding it — a null `icloudDocumentsRoot` alone would read as "signed
 * out".
 */
export function useMobileStorageResolving(): boolean {
  return useMobileOnboardingSelector(selectResolving)
}

/**
 * Which root the open graph lives in — `'icloud'` for the iCloud Drive
 * container, `'local'` for the app sandbox. Null until a graph is open
 * (and always null on desktop). The iCloud foreground refresh keys off
 * this.
 */
export function useMobileStorageKind(): MobileStorageKind | null {
  return useMobileOnboardingSelector(selectKind)
}
