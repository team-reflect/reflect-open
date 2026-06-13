import { type ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { useKeyboardHeightVar } from '@/mobile/use-keyboard'
import { useSettings } from '@/providers/settings-provider'

/**
 * Mobile Today (Plan 19 skeleton): today's daily note in the real editor over
 * the shared document stack — same `NotePane`, sessions, saves, and
 * protections as desktop. Safe-area padding keeps the header out of the
 * notch; the scroll container yields to the keyboard via
 * `--keyboard-height` (the webview keeps its full frame — decision 8). The
 * day pager and capture sheet come in later steps.
 */
export function MobileToday(): ReactElement {
  const { settings } = useSettings()
  const date = todayIso()
  useKeyboardHeightVar()

  return (
    <div className="flex h-dvh w-screen flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="shrink-0 border-b border-border px-4 pb-2 pt-1">
        <h1 className="text-base font-semibold">{formatDayLabel(date, settings.dateFormat)}</h1>
      </header>
      <main
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))' }}
      >
        <NotePane path={dailyPath(date)} lazy gutterClassName="px-4" editorClassName="min-h-[60dvh]" />
      </main>
    </div>
  )
}
