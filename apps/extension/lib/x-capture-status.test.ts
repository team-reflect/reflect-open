import { beforeEach, expect, it, vi } from 'vitest'
import {
  readXCaptureError, reportXCaptureError, dismissXCaptureError,
  readCaptureDelivery, writeCaptureDelivery,
} from './x-capture-status'

const store = new Map<string, unknown>()
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
  get: async (key: string) => ({ [key]: store.get(key) }),
  set: async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) store.set(key, value)
  },
  remove: async (key: string) => { store.delete(key) },
} } } }))
beforeEach(() => { store.clear() })

it('keeps admission failures visible until dismissed without storing raw errors', async () => {
  await reportXCaptureError(new Error('Capture queue full. Details'))
  expect(await readXCaptureError()).toContain('latest X post was not saved')
  await writeCaptureDelivery({ sent: 1, failed: 0, rejectedIds: [], held: 0, holdReason: null })
  expect(await readXCaptureError()).not.toBeNull()
  await dismissXCaptureError()
  expect(await readXCaptureError()).toBeNull()
  await reportXCaptureError(new Error('Sensitive payload text'))
  expect(await readXCaptureError()).not.toContain('Sensitive')
})

it('persists supported queue outcomes and rejects malformed stored status', async () => {
  const result = { sent: 0, failed: 0, rejectedIds: [], held: 1, holdReason: 'unsupported-version' as const }
  await writeCaptureDelivery(result)
  expect(await readCaptureDelivery()).toEqual(result)
  store.set('captureDeliveryStatus', { held: 'broken' })
  expect(await readCaptureDelivery()).toBeNull()
})
