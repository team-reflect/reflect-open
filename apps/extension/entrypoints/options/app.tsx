import { useState, type ReactElement } from 'react'
import { useXCapture } from '@/lib/x/use-x-capture'

/**
 * The extension's settings page — today only the X capture switches
 * (Plan 25). Switching bookmarks on asks Chrome for the x.com origins; a
 * refused prompt leaves the feature off and says so.
 */
export function OptionsPage(): ReactElement {
  const capture = useXCapture()
  const [notice, setNotice] = useState<string | null>(null)

  async function onBookmarksChange(checked: boolean): Promise<void> {
    setNotice(null)
    if (!checked) {
      await capture.disable()
      return
    }
    if (!(await capture.enable())) {
      setNotice('Chrome did not grant access to x.com, so this stays off.')
    }
  }

  const preferences = capture.preferences
  const disabled = preferences === null || capture.busy

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-base font-semibold text-text">Reflect Capture</h1>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-text">X</h2>
        <label className="flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={preferences?.bookmarks ?? false}
            disabled={disabled}
            onChange={(event) => void onBookmarksChange(event.target.checked)}
            className="mt-0.5 size-3.5 rounded border-border text-accent focus:ring-focus-ring"
          />
          <span>
            Save posts you bookmark
            <span className="block text-xs text-text-muted">
              Each post you bookmark on x.com is saved to Reflect with its text, author, and images.
              Runs only on x.com, only after you turn it on.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={preferences?.likes ?? false}
            disabled={disabled || !(preferences?.bookmarks ?? false)}
            onChange={(event) => void capture.setLikes(event.target.checked)}
            className="mt-0.5 size-3.5 rounded border-border text-accent focus:ring-focus-ring"
          />
          <span>
            Also save posts you like
            <span className="block text-xs text-text-muted">
              Off by default: likes are noisier than bookmarks.
            </span>
          </span>
        </label>
        {notice !== null ? <p className="text-xs text-destructive">{notice}</p> : null}
      </section>
    </main>
  )
}
