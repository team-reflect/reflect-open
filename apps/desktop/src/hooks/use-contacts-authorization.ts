import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { contactsAuthorizationStatus, type ContactsAuthorization } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { queryKeys } from '@/lib/query-client'

/**
 * One shared query for the Contacts permission state, consumed by the
 * settings section, the settings navigator (which hides the Apple
 * integrations entry on platforms without the framework), and the
 * suggested-contact gate. Not index data — the key lives outside the
 * `index` scope, and consumers refresh it explicitly after prompting.
 */
/** The Contacts permission state, or `null` while the first read is in flight. */
export function useContactsAuthorization(): ContactsAuthorization | null {
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.contacts.authorization,
    queryFn: () => contactsAuthorizationStatus(),
    enabled: bridgeReady,
  })
  return data ?? null
}

/** Re-read the permission state (after a prompt, or a System Settings trip). */
export function useRefreshContactsAuthorization(): () => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts.authorization }),
    [queryClient],
  )
}
