import { createContext, use, useEffect, useMemo, type ReactElement, type ReactNode } from 'react'
import type { UpdateService, UpdateState } from '@reflect/app'
import { attachUpdateToasts } from '@/components/update-toasts.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

type UpdateContextValue = { state: UpdateState } & Pick<
  UpdateService,
  'supported' | 'checkNow' | 'install' | 'restart' | 'retryAction'
>

const UpdateContext = createContext<UpdateContextValue | null>(null)

interface UpdateProviderProps {
  children: ReactNode
  /**
   * Override the launch + periodic check. Defaults to on in the packaged app
   * and off in dev: `tauri dev` builds would otherwise prompt to "update" to
   * the released version.
   */
  autoCheck?: boolean
}

/**
 * Thin React shim over the app's `UpdateService`, surfaced through
 * `useServiceState`. Mounted above the graph gate so update checks run
 * from first launch, before any graph is open.
 */
export function UpdateProvider({ children, autoCheck }: UpdateProviderProps): ReactElement {
  const { update } = useAppServices()
  const { platform, logger } = useCoreServices()
  const supported = update.supported
  const resolvedAutoCheck = autoCheck ?? !platform.isDev

  // One checker per app: `start` does nothing in a secondary note window.
  useEffect(() => {
    if (!supported) {
      return
    }
    const detachToasts = attachUpdateToasts(update, logger)
    if (resolvedAutoCheck) {
      update.start()
    }
    return () => {
      detachToasts()
      update.dispose()
    }
  }, [update, supported, resolvedAutoCheck, logger])

  const state = useServiceState(update, update.getState)

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      supported: update.supported,
      checkNow: () => update.checkNow(),
      install: () => update.install(),
      restart: () => update.restart(),
      retryAction: () => update.retryAction(),
    }),
    [update, state],
  )

  return <UpdateContext value={value}>{children}</UpdateContext>
}

/**
 * Update state + actions; must be used under an {@link UpdateProvider}.
 */
export function useUpdate(): UpdateContextValue {
  const value = use(UpdateContext)
  if (value === null) {
    throw new Error('useUpdate must be used within an UpdateProvider')
  }
  return value
}
