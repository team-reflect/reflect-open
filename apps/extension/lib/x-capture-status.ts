import { browser } from 'wxt/browser'
import { z } from 'zod'
import { flushResultSchema, type FlushResult } from './messages'

export const X_CAPTURE_ERROR_KEY = 'xCaptureError'
export const CAPTURE_DELIVERY_KEY = 'captureDeliveryStatus'
const errorSchema = z.string().nullable()

/** The latest automatic admission failure, retained until dismissed. */
export async function readXCaptureError(): Promise<string | null> {
  const stored = await browser.storage.local.get(X_CAPTURE_ERROR_KEY)
  const parsed = errorSchema.safeParse(stored[X_CAPTURE_ERROR_KEY])
  return parsed.success ? parsed.data : null
}

export async function reportXCaptureError(cause: unknown): Promise<void> {
  const message =
    cause instanceof Error && cause.message.startsWith('Capture queue full.')
      ? 'Capture queue full. The latest X post was not saved. Existing captures are kept; save the post again after delivery.'
      : 'An X post could not be saved. Check the capture queue and try saving the post again.'
  await browser.storage.local.set({ [X_CAPTURE_ERROR_KEY]: message })
}

export async function dismissXCaptureError(): Promise<void> {
  await browser.storage.local.remove(X_CAPTURE_ERROR_KEY)
}

export async function readCaptureDelivery(): Promise<FlushResult | null> {
  const stored = await browser.storage.local.get(CAPTURE_DELIVERY_KEY)
  const parsed = flushResultSchema.safeParse(stored[CAPTURE_DELIVERY_KEY])
  return parsed.success ? parsed.data : null
}

export async function writeCaptureDelivery(result: FlushResult): Promise<void> {
  await browser.storage.local.set({ [CAPTURE_DELIVERY_KEY]: result })
}
