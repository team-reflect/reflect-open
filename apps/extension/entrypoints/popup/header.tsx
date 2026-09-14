import { Settings } from 'lucide-react'
import type { ReactElement } from 'react'
import { browser } from 'wxt/browser'

/** The popup's title bar: the extension icon and name, and the way to its settings. */
export function PopupHeader(): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-text-secondary">
      <img src="/icon/32.png" alt="" className="size-4 rounded" />
      <span className="flex-1">Save to Reflect</span>
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={() => void browser.runtime.openOptionsPage()}
        className="rounded p-0.5 text-text-muted hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring outline-none"
      >
        <Settings aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}
