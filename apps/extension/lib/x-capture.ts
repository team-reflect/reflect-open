import { z } from 'zod'
import { browser, type Browser } from 'wxt/browser'
import { captureWireMessageSchema } from '@reflect/core/capture-envelope'
import { enqueueCapture, flushQueue } from './flush'
import {
  isXPage,
  X_CONTENT_SCRIPT,
  X_DEFAULT_SETTINGS,
  X_ORIGINS,
  X_SETTINGS_KEY,
} from './x-config'

const settingsSchema = z
  .object({ bookmarks: z.boolean(), likes: z.boolean() })
  .refine((settings) => settings.bookmarks || !settings.likes)
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('x:configure'), settings: settingsSchema }),
  z.object({ type: z.literal('x:capture'), wire: captureWireMessageSchema }),
  z.object({ type: z.literal('x:status') }),
])
export const xSettingsResultSchema = z.object({
  settings: settingsSchema,
  error: z.string().optional(),
})
const SCRIPT_ID = 'reflect-x-capture'
let tail: Promise<unknown> = Promise.resolve()

function serialize<Result>(task: () => Promise<Result>): Promise<Result> {
  const next = tail.then(task, task)
  tail = next
  return next
}

async function readSettings(): Promise<z.infer<typeof settingsSchema>> {
  const stored = (await browser.storage.local.get(X_SETTINGS_KEY))[X_SETTINGS_KEY]
  return settingsSchema.safeParse(stored).data ?? X_DEFAULT_SETTINGS
}

async function reconcile(
  settings: z.infer<typeof settingsSchema>,
): Promise<z.infer<typeof xSettingsResultSchema>> {
  const permitted = await browser.permissions.contains({ origins: X_ORIGINS })
  const next = permitted ? settings : X_DEFAULT_SETTINGS
  if (!next.bookmarks) await browser.storage.local.set({ [X_SETTINGS_KEY]: next })
  const registrations = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })
  if (next.bookmarks) {
    if (registrations.length === 0) {
      await browser.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          matches: X_ORIGINS,
          js: [X_CONTENT_SCRIPT.slice(1)],
          runAt: 'document_idle',
        },
      ])
    }
    await browser.storage.local.set({ [X_SETTINGS_KEY]: next })
    const tabs = await browser.tabs.query({ url: X_ORIGINS })
    const results = await Promise.allSettled(
      tabs.map(async (tab) => {
        if (tab.id !== undefined && tab.url && isXPage(tab.url)) {
          await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: [X_CONTENT_SCRIPT],
          })
        }
      }),
    )
    return {
      settings: next,
      ...(results.some((result) => result.status === 'rejected')
        ? { error: 'Refresh any X tabs where automatic capture has not started.' }
        : {}),
    }
  }
  if (registrations.length > 0)
    await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] })
  const tabs = await browser.tabs.query({})
  await Promise.allSettled(
    tabs.map(async (tab) => {
      if (tab.id !== undefined) await browser.tabs.sendMessage(tab.id, { type: 'x:stop' })
    }),
  )
  return { settings: next }
}

async function handleMessage(
  raw: unknown,
  sender: Browser.runtime.MessageSender,
): Promise<unknown> {
  const message = messageSchema.parse(raw)
  if (sender.id !== browser.runtime.id) return { ok: false, reason: 'sender' }
  if (message.type !== 'x:capture') {
    if (sender.tab) return { ok: false, reason: 'sender' }
    if (message.type === 'x:status') return { settings: await readSettings() }
    return await reconcile(message.settings)
  }
  const { wire } = message
  if (sender.frameId !== 0 || !sender.tab?.url || !isXPage(sender.tab.url)) {
    return { ok: false, reason: 'sender' }
  }
  if (wire.envelope.version !== 2 || wire.envelope.x.trigger === 'manual') {
    return { ok: false, reason: 'payload' }
  }
  const settings = await readSettings()
  if (!settings.bookmarks || (wire.envelope.x.trigger === 'like' && !settings.likes)) {
    return { ok: false, reason: 'disabled' }
  }
  if (!(await browser.permissions.contains({ origins: X_ORIGINS }))) {
    return { ok: false, reason: 'permission' }
  }
  await enqueueCapture(wire)
  void flushQueue().catch((cause: unknown) => console.error('X capture flush failed:', cause))
  return { ok: true, status: 'queued' }
}

/** Own X settings, watcher lifecycle, and durable automatic capture acknowledgement. */
export function installXCaptureHandlers(): void {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      !['x:capture', 'x:configure', 'x:status'].includes(String(message.type))
    )
      return false
    void serialize(() => handleMessage(message, sender)).then(sendResponse, (cause: unknown) => {
      sendResponse({
        ok: false,
        reason: cause instanceof z.ZodError ? 'payload' : 'retry',
        error: String(cause),
      })
    })
    return true
  })
  const refresh = () => {
    void serialize(async () => await reconcile(await readSettings())).catch((cause: unknown) =>
      console.error('X capture settings failed:', cause),
    )
  }
  browser.runtime.onInstalled.addListener(refresh)
  browser.runtime.onStartup.addListener(refresh)
  browser.permissions.onRemoved.addListener(refresh)
}
