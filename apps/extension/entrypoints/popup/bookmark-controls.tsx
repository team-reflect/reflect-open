import { useEffect, useState, type ReactElement } from 'react'
import { z } from 'zod'
import { browser } from 'wxt/browser'
import { getBookmarkPostId } from '@reflect/core/capture-envelope'
import {
  BOOKMARK_SETTINGS_KEY,
  getBookmarkCapability,
  readBookmarkSettings,
  type BookmarkSettings,
} from '@/lib/bookmark-settings'

/** Profile-wide bookmark capture preferences and explicit post saving. */
export function BookmarkControls({ url }: { url: string }): ReactElement {
  const [settings, setSettings] = useState<BookmarkSettings>({
    enabled: false,
    presentation: 'link',
  })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(true)
  const postId = getBookmarkPostId(url)
  useEffect(() => {
    let active = true
    void Promise.all([
      readBookmarkSettings(),
      browser.storage.local.get(['bookmarkError', 'captureQueueError']),
    ]).then(
      ([value, errors]) => {
        if (active) {
          setSettings(value)
          setMessage(String(errors['captureQueueError'] ?? errors['bookmarkError'] ?? ''))
          setBusy(false)
        }
      },
      () => {
        if (active) {
          setMessage('Could not load bookmark settings.')
          setBusy(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [])

  async function persist(next: BookmarkSettings): Promise<void> {
    await browser.storage.local.set({ [BOOKMARK_SETTINGS_KEY]: next })
    setSettings(next)
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Bookmark capture failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="flex flex-col gap-2 border-b border-border p-3" disabled={busy}>
      <legend className="text-sm font-medium text-text">X bookmarks</legend>
      <p className="text-xs text-text-muted">
        Save links to your daily note. Automatic capture records bookmark requests, including
        requests X may reject. Applies to every X account in this Chrome profile.
      </p>
      <button
        type="button"
        className="text-left text-xs text-accent underline"
        onClick={() => {
          void perform(async () => {
            const capability = await getBookmarkCapability()
            await persist({ ...settings, targetGraphId: capability.targetGraphId, enabled: false })
            await browser.storage.local.remove('bookmarkError')
            await browser.action.setBadgeText({ text: '' })
            setMessage('Paired with the graph currently selected in Reflect.')
          })
        }}
      >
        Pair with current Reflect graph
      </button>
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={!settings.targetGraphId}
          onChange={(event) => {
            const enabled = event.target.checked
            // Permission requests must begin in the user gesture, before awaiting IO.
            const granted = enabled
              ? browser.permissions.request({
                  permissions: ['webRequest'],
                  origins: ['https://x.com/*'],
                })
              : Promise.resolve(true)
            void perform(async () => {
              if (!(await granted)) throw new Error('X permission was not granted.')
              await persist({ ...settings, enabled })
              setMessage(
                enabled
                  ? 'Automatic request capture enabled. Historical bookmarks are not imported.'
                  : 'Automatic capture disabled. Accepted captures remain queued.',
              )
            })
          }}
        />
        Record new bookmark requests (experimental)
      </label>
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={settings.presentation === 'embed'}
          onChange={(event) => {
            const presentation = event.target.checked ? 'embed' : 'link'
            void perform(() => persist({ ...settings, presentation }))
          }}
        />
        Show online tweet previews for new captures
      </label>
      <p className="text-xs text-text-muted">
        Previews contact X. Private daily notes receive links. Tweet text and media are not
        archived.
      </p>
      {postId ? (
        <button
          type="button"
          disabled={!settings.targetGraphId}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-text-on-brand disabled:opacity-60"
          onClick={() => {
            void perform(async () => {
              const response = z
                .object({ ok: z.boolean(), message: z.string().optional() })
                .parse(await browser.runtime.sendMessage({ type: 'save-bookmark', postId }))
              if (!response.ok) throw new Error(response.message ?? 'Could not save post.')
              setMessage('Accepted for delivery. Check Reflect or retry pending captures below.')
            })
          }}
        >
          Save post link to daily note
        </button>
      ) : null}
      <button
        type="button"
        className="text-left text-xs text-accent underline"
        onClick={() => {
          void perform(async () => {
            const response = await browser.runtime.sendMessage({ type: 'flush' })
            const result = z.object({ held: z.number() }).parse(response)
            setMessage(
              result.held
                ? `${result.held} captures still waiting. Open the paired graph in Reflect.`
                : 'All pending captures queued with Reflect.',
            )
          })
        }}
      >
        Retry pending captures
      </button>
      {message ? (
        <p role="status" className="text-xs text-text-muted">
          {message}
        </p>
      ) : null}
    </fieldset>
  )
}
