import type { ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { RouteContent } from '@/components/route-content'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'
import { useRouter } from '@/routing/router'
import { ScrollRestored } from '@/routing/scroll-restore'

/**
 * A secondary note window's whole surface (⌘-click → new window): the routed
 * view, full-bleed — no workspace sidebar, no context panel, no palette or
 * dialogs. A note window is an editing surface; every other affordance lives
 * in the main window.
 *
 * Daily targets render as a **single note pane**, not the daily stream: this
 * window shows the one note that was ⌘-clicked, so a daily source is treated
 * like any other note (`lazy` covers a not-yet-created day, same as the
 * stream's placeholder behavior).
 */
export function NoteWindowContent(): ReactElement {
  const { route } = useRouter()
  const { settings } = useSettings()
  const dailyDate =
    route.kind === 'daily' ? route.date : route.kind === 'today' ? todayIso() : null

  return (
    <div className="h-screen w-screen overflow-hidden bg-surface text-text">
      {dailyDate !== null ? (
        // Mirrors RouteContent's note route (padding on the inner column so
        // `min-h-full` fills the viewport; the gutter is the editor's own
        // padding so the whole body is click-to-focus), with the stream's day
        // label standing in for the title a daily note doesn't carry.
        <ScrollRestored className="h-full overflow-auto px-0">
          <div className="mx-auto flex min-h-full w-full max-w-full flex-col py-8">
            <h2 className="reflect-daily-subject reflect-content-gutter mb-3">
              {formatDayLabel(dailyDate, settings.dateFormat)}
            </h2>
            <NotePane
              path={dailyPath(dailyDate)}
              dailyDate={dailyDate}
              lazy
              autoFocus
              className="flex grow flex-col"
              gutterClassName="reflect-content-gutter"
              editorClassName="grow"
            />
          </div>
        </ScrollRestored>
      ) : (
        <RouteContent />
      )}
    </div>
  )
}
