import { useEffect, useRef } from 'react'
import type { LoggerService, Operation } from '@reflect/core'
import { toast } from '@/components/ui/toast.tsx'
import { useStore } from '@/lib/use-store.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * The desktop face of the operations store (foundations hardening): a small,
 * unobtrusive toast stack for background operations that outlive their pane —
 * the rename rewrite is the first tenant; indexing/sync states can migrate
 * here as they're touched. Mobile renders the same store as pills instead
 * ({@link MobileOperationsPills}).
 */

// `timeout: 0` disables Base UI's auto-dismiss (the store owns lingering and
// removal); the dismissible flag hides the close button and disables
// swipe-to-dismiss (see `ToastData` in `ui/toast.tsx`).
const NON_DISMISSIBLE_OPERATION_OPTIONS = {
  timeout: 0,
  data: { dismissible: false },
}

function toastId(operation: Operation): string {
  return `operation-${operation.id}`
}

function descriptionFor(operation: Operation): string | undefined {
  if (operation.status !== 'running' && operation.message !== null) {
    return operation.message
  }
  if (operation.progress !== null) {
    return `${operation.progress.done}/${operation.progress.total}`
  }
  return operation.description ?? undefined
}

function showOperationToast(operation: Operation, logger: LoggerService): void {
  const operationAction = operation.action
  const actionProps = operationAction
    ? {
        children: operationAction.label,
        onClick: () => {
          void Promise.resolve(operationAction.run()).catch((error: unknown) => {
            logger.error('operation action failed:', error)
          })
        },
      }
    : undefined
  const options = {
    id: toastId(operation),
    title: operation.label,
    description: descriptionFor(operation),
    ...NON_DISMISSIBLE_OPERATION_OPTIONS,
    actionProps,
  }

  switch (operation.status) {
    case 'failed':
      toast.add({ ...options, type: 'error' })
      break
    case 'warning':
      toast.add({ ...options, type: 'warning' })
      break
    case 'running':
      // Explicit undefined clears a stale error/warning icon if the same
      // operation id returns to running (`add()` merges by id).
      toast.add({ ...options, type: undefined })
      break
  }
}

/**
 * Mirrors the operations store into toasts.
 */
export function OperationToasts(): null {
  const { operations } = useAppServices()
  const { logger } = useCoreServices()
  const current = useStore(operations)
  const shownIdsRef = useRef(new Set<number>())
  useEffect(() => {
    const nextIds = new Set(current.map((operation) => operation.id))
    for (const id of shownIdsRef.current) {
      if (!nextIds.has(id)) {
        toast.close(`operation-${id}`)
      }
    }
    for (const operation of current) {
      showOperationToast(operation, logger)
    }
    shownIdsRef.current = nextIds
  }, [current, logger])
  return null
}
