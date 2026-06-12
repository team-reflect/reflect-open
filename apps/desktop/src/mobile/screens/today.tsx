import { type ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'

/**
 * Mobile Today (Plan 19 skeleton): today's daily note in the real editor over
 * the shared document stack — same `NotePane`, sessions, saves, and
 * protections as desktop. Safe-area padding keeps the header out of the
 * notch; the day pager and capture sheet come in later steps.
 */
export function MobileToday(): ReactElement {
  const { settings } = useSettings()
  const date = todayIso()

  return (
    <div className="flex h-dvh w-screen flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="shrink-0 border-b border-border px-4 pb-2 pt-1">
        <h1 className="text-base font-semibold">{formatDayLabel(date, settings.dateFormat)}</h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <NotePane
          path={dailyPath(date)}
          lazy
          className="pb-[env(safe-area-inset-bottom)]"
          gutterClassName="px-4"
          editorClassName="min-h-[60dvh]"
        />
      </main>
    </div>
  )
}
