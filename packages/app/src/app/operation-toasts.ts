import type { LoggerService, Operation } from '@reflect/core'
import type { KeyedToastSpec } from './toast-service.ts'

function getOperationDescription(operation: Operation): string | undefined {
  if (operation.status !== 'running' && operation.message !== null) {
    return operation.message
  }
  if (operation.progress !== null) {
    return `${operation.progress.done}/${operation.progress.total}`
  }
  return operation.description ?? undefined
}

const OPERATION_TOAST_TYPES = {
  running: undefined,
  warning: 'warning',
  failed: 'error',
} as const

/**
 * The desktop face of an operation (foundations hardening): a toast that stays
 * open while the operations store keeps the operation. Mobile renders the same
 * store as pills instead.
 */
export function getOperationToast(operation: Operation, logger: LoggerService): KeyedToastSpec {
  const operationAction = operation.action
  return {
    id: `operation-${operation.id}`,
    title: operation.label,
    description: getOperationDescription(operation),
    type: OPERATION_TOAST_TYPES[operation.status],
    timeout: 0,
    dismissible: false,
    action: operationAction
      ? {
          label: operationAction.label,
          run: () => {
            void (async () => {
              try {
                await operationAction.run()
              } catch (error: unknown) {
                logger.error('operation action failed:', error)
              }
            })()
          },
        }
      : undefined,
  }
}
