import { createContext, use } from 'react'
import type { ToastManager } from '@base-ui/react/toast'
import { toast, type ToastData } from '@/components/ui/toast.tsx'

/**
 * The part of the toast manager that components call. A call only sends an
 * event to the `Toaster`, so it never re-renders the caller.
 */
export type ToastController = Pick<ToastManager<ToastData>, 'add' | 'close'>

/**
 * Holds the global `toast` manager by default. Tests provide a fake.
 */
export const ToastControllerContext = createContext<ToastController>(toast)

/**
 * Returns the toast manager from {@link ToastControllerContext}. The value
 * never changes, so reading it never re-renders.
 */
export function useToastController(): ToastController {
  return use(ToastControllerContext)
}
