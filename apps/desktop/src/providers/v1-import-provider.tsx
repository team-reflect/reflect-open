import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createV1ImportService, type V1ImportService, type V1ImportState } from '@reflect/core'
import { V1ImportDialog } from '@/components/v1-import-dialog.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

type V1ImportContextValue = { state: V1ImportState } & Pick<V1ImportService, 'dismiss'> & {
    /**
     * `V1ImportService.start`.
     */
    startImport: V1ImportService['start']
    /**
     * `V1ImportService.cancel`.
     */
    cancelImport: V1ImportService['cancel']
  }

const V1ImportContext = createContext<V1ImportContextValue | null>(null)

interface V1ImportProviderProps {
  children: ReactNode
}

/**
 * Owns the Reflect V1 import for the workspace: the settings section only
 * picks the zip; the import itself lives in a `V1ImportService` of this
 * workspace so navigating away from settings can't orphan it. Renders the
 * modal progress dialog ({@link V1ImportDialog}) above the routed views — the
 * import is the only activity until it finishes, errors, or is cancelled.
 */
export function V1ImportProvider({ children }: V1ImportProviderProps): ReactElement {
  const { ipc, fileChanges, graphSession, clock, logger } = useCoreServices()
  const [service] = useState(() => {
    return createV1ImportService({ ipc, fileChanges, graphSession, clock, logger })
  })
  const state = useServiceState(service, service.getState)

  // Unmounting mid-import (graph switch, app teardown) cancels the import.
  useEffect(() => service.attach(), [service])

  const value = useMemo<V1ImportContextValue>(
    () => ({
      state,
      dismiss: () => service.dismiss(),
      startImport: (zipPath) => service.start(zipPath),
      cancelImport: () => service.cancel(),
    }),
    [state, service],
  )

  return (
    <V1ImportContext value={value}>
      {children}
      <V1ImportDialog
        state={state}
        onCancel={() => service.cancel()}
        onDismiss={() => service.dismiss()}
      />
    </V1ImportContext>
  )
}

/**
 * The workspace's Reflect V1 import (state + controls).
 */
export function useV1Import(): V1ImportContextValue {
  const context = use(V1ImportContext)
  if (context === null) {
    throw new Error('useV1Import must be used within V1ImportProvider')
  }
  return context
}
