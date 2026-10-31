import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { ClassicAccess, ClassicSignInResult } from '@reflect/core'
import { mutationKeys, mutationScopeIds } from '@/lib/query-client.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * This device's Reflect Classic access as stored in the keychain. Loading
 * covers only the keychain read; the service rechecks with Reflect Classic in
 * the background while this is mounted.
 */
export function useClassicAccess(): {
  value: ClassicAccess | null
  active: boolean
  isLoading: boolean
} {
  const { classicAccess: classic, platform } = useCoreServices()
  const enabled = platform.appPlatform === 'ios'
  const state = useServiceState(classic, classic.getState)

  useEffect(() => classic.start(), [classic])

  return {
    value: enabled ? state.access : null,
    active: enabled && state.active,
    isLoading: enabled && state.isLoading,
  }
}

/**
 * Verifies a Reflect Classic subscription; the argument asks for a private
 * sign-in session. `checking` is true once the sign-in sheet has closed and
 * the subscription is being read.
 */
export function useClassicSignIn() {
  const { classicAccess: classic, logger } = useCoreServices()
  const [browserClosed, setBrowserClosed] = useState(false)
  const mutation = useMutation<ClassicSignInResult, Error, boolean>({
    mutationKey: mutationKeys.classic.signIn,
    scope: { id: mutationScopeIds.iapAction },
    mutationFn: (ephemeral) => {
      setBrowserClosed(false)
      return classic.signIn({ ephemeral, onSheetClosed: () => setBrowserClosed(true) })
    },
    onError: (error) => {
      logger.error('Verifying the Reflect Classic subscription failed', error)
    },
  })
  return { mutation, checking: mutation.isPending && browserClosed }
}

export type ClassicSignIn = ReturnType<typeof useClassicSignIn>

/**
 * Forgets this device's Reflect Classic verification.
 */
export function useClassicSignOut() {
  const { classicAccess: classic } = useCoreServices()
  return useMutation({
    mutationKey: mutationKeys.classic.signOut,
    mutationFn: async () => {
      await classic.signOut()
    },
  })
}

/**
 * The status line for a stored verification, or `null` for none.
 */
export function classicAccessMessage(classicAccess: {
  value: ClassicAccess | null
  active: boolean
}): string | null {
  return classicAccess.value !== null && !classicAccess.active
    ? 'Your Reflect Classic access to Reflect Open has ended.'
    : null
}
