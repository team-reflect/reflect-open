import { errorMessage } from '@reflect/core'
import type { ToastController } from '@/lib/use-toasts.ts'
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'

/**
 * The words of a failed action: the error's message, and its cause's.
 */
export interface ActionErrorText {
  title: string
  description: string | undefined
}

export function describeActionError(error: unknown): ActionErrorText {
  return {
    title: errorMessage(error),
    description:
      error instanceof Error && error.cause !== undefined ? errorMessage(error.cause) : undefined,
  }
}

/**
 * Run the action `id` of `chrome`. A rejection shows as an error toast.
 */
export async function runChromeAction(
  chrome: ScreenChrome | undefined,
  id: string,
  toasts: ToastController,
): Promise<void> {
  try {
    await chrome?.onAction?.(id)
  } catch (error) {
    const { title, description } = describeActionError(error)
    toasts.add({ type: 'error', title, ...(description === undefined ? {} : { description }) })
  }
}
