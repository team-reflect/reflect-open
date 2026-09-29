import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearClassicAccess,
  isClassicAccessActive,
  loadClassicAccess,
  readClassicAccess,
  signInWithClassic,
  startWebAuth,
  type ClassicAccess,
  type ClassicSignInResult,
} from '@reflect/core'
import { providerFetch } from '@/lib/provider-fetch.ts'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

interface ClassicAccessState {
  access: ClassicAccess | null
  active: boolean
}

// Runs when the query data changes (at most hourly, on focus), not on every render.
function withActive(access: ClassicAccess | null): ClassicAccessState {
  return { access, active: access !== null && isClassicAccessActive(access, Date.now()) }
}

/**
 * This device's Reflect Classic access as stored in the keychain. Loading
 * covers only the keychain read; the daily recheck with Reflect Classic runs
 * in the background and writes its answer back.
 */
export function useClassicAccess(): {
  value: ClassicAccess | null
  active: boolean
  isLoading: boolean
} {
  const { platform } = useGraph()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.classic.access,
    queryFn: readClassicAccess,
    enabled: platform === 'ios',
    select: withActive,
  })
  useQuery({
    queryKey: queryKeys.classic.recheck,
    queryFn: async () => {
      const access = await loadClassicAccess(providerFetch)
      queryClient.setQueryData(queryKeys.classic.access, access)
      return access
    },
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: true,
    enabled: platform === 'ios' && query.data?.access?.token != null,
  })
  return {
    value: query.data?.access ?? null,
    active: query.data?.active ?? false,
    isLoading: query.isLoading,
  }
}

/**
 * Verifies a Reflect Classic subscription; the argument asks for a private
 * sign-in session. `checking` is true once the sign-in sheet has closed and
 * the subscription is being read.
 */
export function useClassicSignIn() {
  const [browserClosed, setBrowserClosed] = useState(false)
  const mutation = useMutation<ClassicSignInResult, Error, boolean>({
    mutationKey: mutationKeys.classic.signIn,
    scope: { id: mutationScopeIds.iapAction },
    mutationFn: (ephemeral) => {
      setBrowserClosed(false)
      return signInWithClassic({
        ephemeral,
        fetchFn: providerFetch,
        startWebAuth: async (options) => {
          const callback = await startWebAuth(options)
          if (callback !== null) setBrowserClosed(true)
          return callback
        },
      })
    },
    onError: (error) => {
      console.error('Verifying the Reflect Classic subscription failed', error)
    },
  })
  return { mutation, checking: mutation.isPending && browserClosed }
}

export type ClassicSignIn = ReturnType<typeof useClassicSignIn>

/** Forgets this device's Reflect Classic verification. */
export function useClassicSignOut() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: mutationKeys.classic.signOut,
    mutationFn: clearClassicAccess,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.classic.access }),
  })
}

export function formatClassicDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** The status line for a stored verification, or `null` for none. */
export function classicAccessMessage(classicAccess: {
  value: ClassicAccess | null
  active: boolean
}): string | null {
  return classicAccess.value !== null && !classicAccess.active
    ? 'Your Reflect Classic access to Reflect Open has ended.'
    : null
}
