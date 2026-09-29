import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearClassicAccess,
  isClassicAccessActive,
  loadClassicAccess,
  signInWithClassic,
  startWebAuth,
  type ClassicAccess,
  type ClassicSignInResult,
} from '@reflect/core'
import { providerFetch } from '@/lib/provider-fetch.ts'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/** User-facing copy. It must read as verifying a subscription, never as syncing notes. */
export const CLASSIC_COPY = {
  verifyButton: 'Verify Reflect Classic subscription',
  verifyRow: 'Verify Reflect Classic Subscription',
  removeRow: 'Remove Reflect Classic Verification',
  verifiedAccountLabel: 'Verified Account',
  hint: 'This only checks your subscription. Nothing is synced with Reflect Classic.',
  differentAccount: 'Use a different Reflect Classic account',
  failed: 'Could not verify your Reflect Classic subscription. Try again.',
  notEligible: "This Reflect Classic account doesn't include Reflect Open.",
  ended: 'Your Reflect Classic access to Reflect Open has ended.',
} as const

interface ClassicAccessState {
  access: ClassicAccess | null
  active: boolean
}

// Runs when the query data changes (at most hourly, on focus), not on every render.
function withActive(access: ClassicAccess | null): ClassicAccessState {
  return { access, active: access !== null && isClassicAccessActive(access, Date.now()) }
}

/** This device's Reflect Classic access, from the keychain and rechecked at most daily. */
export function useClassicAccess(): {
  value: ClassicAccess | null
  active: boolean
  isLoading: boolean
} {
  const { platform } = useGraph()
  const query = useQuery({
    queryKey: queryKeys.classic.access,
    queryFn: () => loadClassicAccess(providerFetch),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: true,
    enabled: platform === 'ios',
    select: withActive,
  })
  return {
    value: query.data?.access ?? null,
    active: query.data?.active ?? false,
    isLoading: query.isLoading,
  }
}

/** Verifies a Reflect Classic subscription; the argument asks for a private sign-in session. */
export function useClassicSignIn() {
  const queryClient = useQueryClient()
  return useMutation<ClassicSignInResult, Error, boolean>({
    mutationKey: mutationKeys.classic.signIn,
    scope: { id: mutationScopeIds.iapAction },
    mutationFn: (ephemeral) =>
      signInWithClassic({ ephemeral, fetchFn: providerFetch, startWebAuth }),
    onError: (error) => {
      console.error('Verifying the Reflect Classic subscription failed', error)
    },
    onSuccess: async (result) => {
      if (result.kind === 'signed-in') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.classic.access })
      }
    },
  })
}

/** Forgets this device's Reflect Classic verification. */
export function useClassicSignOut() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: mutationKeys.classic.signOut,
    mutationFn: clearClassicAccess,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.classic.access }),
  })
}

/** The status line to show next to the verify action, or `null` for none. */
export function classicAccessMessage(
  classicAccess: { value: ClassicAccess | null; active: boolean },
  signIn: ReturnType<typeof useClassicSignIn>,
): string | null {
  if (signIn.isError) return CLASSIC_COPY.failed
  if (signIn.data?.kind === 'not-eligible') return CLASSIC_COPY.notEligible
  if (classicAccess.value !== null && !classicAccess.active) return CLASSIC_COPY.ended
  return null
}
