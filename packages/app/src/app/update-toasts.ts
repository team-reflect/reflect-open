import type { MaybePromise } from '@reflect/utils'
import type { LoggerService } from '@reflect/core'
import type { KeyedToastSpec, ToastAction } from './toast-service.ts'
import type { UpdateService, UpdateState } from './update-service.ts'

export const UPDATE_TOAST_ID = 'reflect-update'

function createUpdateAction(
  label: string,
  run: () => MaybePromise<void>,
  logger: LoggerService,
): ToastAction {
  return {
    label,
    run: () => {
      void (async () => {
        try {
          await run()
        } catch (error: unknown) {
          logger.error('update toast action failed:', error)
        }
      })()
    },
  }
}

/**
 * The toast for each auto-update phase (Plan 15): none, or one that stays
 * open until the phase changes.
 */
export function getUpdateToasts(
  state: UpdateState,
  update: UpdateService,
  logger: LoggerService,
): readonly KeyedToastSpec[] {
  const base = { id: UPDATE_TOAST_ID, timeout: 0, dismissible: false }
  switch (state.phase) {
    case 'available':
      return [
        {
          ...base,
          title: 'Update available',
          description: `Reflect ${state.version} is ready to install.`,
          action: createUpdateAction('Install', () => update.install(), logger),
        },
      ]
    case 'downloading':
      return [
        {
          ...base,
          title: 'Downloading update',
          description: state.percent !== null ? `${state.percent}%` : 'Preparing…',
          type: 'loading',
        },
      ]
    case 'ready':
      return [
        {
          ...base,
          title: 'Update ready',
          description: `Reflect ${state.version} will finish updating after restart.`,
          type: 'success',
          action: createUpdateAction('Restart', () => update.restart(), logger),
        },
      ]
    case 'error':
      return state.during === 'install'
        ? [
            {
              ...base,
              title: 'Update failed',
              description: state.message,
              type: 'error',
              action: createUpdateAction('Retry install', () => update.retryAction(), logger),
            },
          ]
        : []
    default:
      return []
  }
}
