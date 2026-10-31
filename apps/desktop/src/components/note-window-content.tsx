import type { ReactElement } from 'react'
import { NoteFindBar } from '@/components/note-find-bar.tsx'
import { RouteContent } from '@/components/route-content.tsx'
import { SingleNoteView } from '@/components/single-note-view.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { useNoteWindowTitle } from '@/hooks/use-note-window-title.ts'
import { getIsoToday } from '@reflect/utils'
import { dailyPath, displayNoteTitle, formatDayLabel } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useRouter } from '@/routing/router.tsx'

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
    route.kind === 'daily' ? route.date : route.kind === 'today' ? getIsoToday() : null

  // The OS window title follows the shown note — the day label for dailies,
  // the indexed title otherwise (it tracks renames because the row rides the
  // same query cache the pane invalidates on index writes).
  const noteRow = useNoteRow(route.kind === 'note' ? route.path : '')
  useNoteWindowTitle(
    dailyDate !== null
      ? formatDayLabel(dailyDate, settings.dateFormat)
      : route.kind === 'note'
        ? noteRow
          ? displayNoteTitle(noteRow.title)
          : null
        : null,
  )

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-surface text-text">
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
      <NoteFindBar />
    </div>
  )
}
