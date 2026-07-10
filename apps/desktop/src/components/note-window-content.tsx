import type { ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { RouteContent } from '@/components/route-content'
import { SingleNoteView } from '@/components/single-note-view'
import { useNoteRow } from '@/hooks/use-note-row'
import { useNoteWindowTitle } from '@/hooks/use-note-window-title'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'
import { useRouter } from '@/routing/router'

/**
 * A secondary note window's whole surface: the routed view, full-bleed — no
 * workspace sidebar, context panel, palette, or dialogs. A note window is an
 * editing surface; every other affordance lives in the main window.
 *
 * Daily targets render as a **single note pane**, not the daily stream: this
 * window shows the one requested note, so a daily source is treated like any
 * other note (`lazy` covers a not-yet-created day, same as the stream's
 * placeholder behavior).
 */
export function NoteWindowContent(): ReactElement {
  const { route } = useRouter()
  const { settings } = useSettings()
  const dailyDate =
    route.kind === 'daily' ? route.date : route.kind === 'today' ? todayIso() : null

  // The OS window title follows the shown note — the day label for dailies,
  // the indexed title otherwise (it tracks renames because the row rides the
  // same query cache the pane invalidates on index writes).
  const noteRow = useNoteRow(route.kind === 'note' ? route.path : '')
  useNoteWindowTitle(
    dailyDate !== null
      ? formatDayLabel(dailyDate, settings.dateFormat)
      : route.kind === 'note'
        ? noteRow?.title ?? null
        : null,
  )

  return (
    <div className="h-screen w-screen overflow-hidden bg-surface text-text">
      {dailyDate !== null ? (
        <SingleNoteView
          path={dailyPath(dailyDate)}
          dailyDate={dailyDate}
          heading={
            // The stream's day label, standing in for the title a daily
            // note doesn't carry.
            <h2 className="reflect-daily-subject reflect-content-gutter mb-3">
              {formatDayLabel(dailyDate, settings.dateFormat)}
            </h2>
          }
        />
      ) : (
        <RouteContent />
      )}
    </div>
  )
}
