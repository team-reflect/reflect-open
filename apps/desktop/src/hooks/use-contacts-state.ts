import { contactsCanLookup, type ContactsState } from '@reflect/core'
import { useCallback } from 'react'
import { useStore, useSelector } from '@/lib/use-store.ts'
import { useContactsEnabled } from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The Contacts permission state as `ContactsService` last read it; re-renders on change.
 */
export function useContactsState(): ContactsState {
  const { contacts } = useCoreServices()
  return useStore(contacts)
}

/**
 * The contacts gate: the integration is enabled and the permission is readable.
 * Re-renders only when the gate opens or closes.
 */
export function useContactsCanLookup(): boolean {
  const { contacts } = useCoreServices()
  const contactsEnabled = useContactsEnabled()
  const selector = useCallback(
    (state: ContactsState) => {
      return contactsCanLookup(state, { contactsEnabled })
    },
    [contactsEnabled],
  )
  return useSelector(contacts, selector)
}
