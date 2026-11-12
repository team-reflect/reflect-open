import type { MouseEvent, ReactNode } from 'react'
import type { ToastManagerAddOptions } from '@base-ui/react/toast'
import { vi, type Mock } from 'vitest'
import type { ToastData } from '@/components/ui/toast.tsx'
import { ToastControllerContext, type ToastController } from '@/lib/use-toasts.ts'

type ToastOptions = ToastManagerAddOptions<ToastData>

/**
 * A toast manager that keeps the open toasts in memory. `add` and `close` are
 * spies over that behavior.
 */
export interface TestToastController extends ToastController {
  readonly add: Mock<(options: ToastOptions) => string>
  readonly close: Mock<(id?: string) => void>
  /**
   * The open toasts, oldest first.
   */
  open(): readonly ToastOptions[]
}

export function createTestToastController(): TestToastController {
  const toasts = new Map<string, ToastOptions>()
  let nextId = 0
  return {
    add: vi.fn((options: ToastOptions) => {
      nextId += 1
      const id = options.id ?? `toast-${nextId}`
      // Like the Base UI manager: an open toast with the same id takes the new options.
      toasts.set(id, { ...toasts.get(id), ...options, id })
      return id
    }),
    close: vi.fn((id?: string) => {
      const ids = id === undefined ? [...toasts.keys()] : [id]
      for (const key of ids) {
        const closed = toasts.get(key)
        toasts.delete(key)
        closed?.onClose?.()
      }
    }),
    open: () => [...toasts.values()],
  }
}

/**
 * Returns a `wrapper` for `renderInApp` that provides `toastController`.
 */
export function withToastController(
  toastController: ToastController,
): (children: ReactNode) => ReactNode {
  return (children) => (
    <ToastControllerContext value={toastController}>{children}</ToastControllerContext>
  )
}

/**
 * Clicks the action button of a toast. The toast handlers do not read the event.
 */
export function clickToastAction(options: ToastOptions | undefined): void {
  options?.actionProps?.onClick?.({} as MouseEvent<HTMLButtonElement>)
}
