import { useEffect } from 'react'
import type { MaybePromise } from '@reflect/utils'
import type { UpdateService, UpdateState } from '@reflect/app'
import type { LoggerService } from '@reflect/core'
import { useToastController, type ToastController } from '@/lib/use-toasts.ts'
import { useStore } from '@/lib/use-store.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

const UPDATE_TOAST_ID = 'reflect-update'
// `timeout: 0` disables Base UI's auto-dismiss; the dismissible flag hides the
// close button and disables swipe-to-dismiss (see `ToastData` in
// `ui/toast.tsx`).
const NON_DISMISSIBLE_UPDATE_OPTIONS = {
  timeout: 0,
  data: { dismissible: false },
}

async function runToastAction(
  action: () => MaybePromise<void>,
  logger: LoggerService,
): Promise<void> {
  try {
    await action()
  } catch (error: unknown) {
    logger.error('update toast action failed:', error)
  }
}

function showUpdateToast(
  toastController: ToastController,
  state: UpdateState,
  update: UpdateService,
  logger: LoggerService,
): void {
  switch (state.phase) {
    case 'available':
      toastController.add({
        id: UPDATE_TOAST_ID,
        title: 'Update available',
        description: `Reflect ${state.version} is ready to install.`,
        // `add()` with an existing id merges into the current toast, so this
        // phase clears any stale type (e.g. a lingering spinner) explicitly.
        type: undefined,
        ...NON_DISMISSIBLE_UPDATE_OPTIONS,
        actionProps: {
          children: 'Install',
          onClick: () => void runToastAction(() => update.install(), logger),
        },
      })
      break
    case 'downloading':
      toastController.add({
        id: UPDATE_TOAST_ID,
        title: 'Downloading update',
        description: state.percent !== null ? `${state.percent}%` : 'Preparing…',
        type: 'loading',
        // Same merge semantics: without this the "Install" action from the
        // `available` phase would linger as a clickable control over the
        // download progress. The update only becomes installable once it has
        // fully downloaded, surfaced as "Restart" in the `ready` phase.
        actionProps: undefined,
        ...NON_DISMISSIBLE_UPDATE_OPTIONS,
      })
      break
    case 'ready':
      toastController.add({
        id: UPDATE_TOAST_ID,
        title: 'Update ready',
        description: `Reflect ${state.version} will finish updating after restart.`,
        type: 'success',
        ...NON_DISMISSIBLE_UPDATE_OPTIONS,
        actionProps: {
          children: 'Restart',
          onClick: () => void runToastAction(() => update.restart(), logger),
        },
      })
      break
    case 'error':
      if (state.during === 'install') {
        toastController.add({
          id: UPDATE_TOAST_ID,
          title: 'Update failed',
          description: state.message,
          type: 'error',
          ...NON_DISMISSIBLE_UPDATE_OPTIONS,
          actionProps: {
            children: 'Retry install',
            onClick: () => void runToastAction(() => update.retryAction(), logger),
          },
        })
      } else {
        toastController.close(UPDATE_TOAST_ID)
      }
      break
    default:
      toastController.close(UPDATE_TOAST_ID)
      break
  }
}

/**
 * Mirrors the auto-update lifecycle into the global toast surface (Plan 15).
 */
export function UpdateToasts(): null {
  const { update } = useAppServices()
  const { logger } = useCoreServices()
  const toastController = useToastController()
  const state = useStore(update)
  useEffect(() => {
    showUpdateToast(toastController, state, update, logger)
  }, [toastController, state, update, logger])
  return null
}
