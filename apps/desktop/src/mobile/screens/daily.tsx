import { useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { dailyPath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { Button } from '@/components/ui/button'
import { addDaysIso, formatDayLabel } from '@/lib/dates'
import { useToday } from '@/lib/use-today'
import { CaptureSheet } from '@/mobile/capture-sheet'
import { useSettings } from '@/providers/settings-provider'
import { useRouter } from '@/routing/router'

/**
 * One daily note — the mobile spine (Plan 19). The header pages between
 * days, with a jump back to today whenever the view has wandered; the body
 * is the shared document stack via `NotePane`, exactly as on desktop. The
 * scroll container yields to the keyboard via `--keyboard-height`, and the
 * capture button floats above both.
 */
export function MobileDaily({ date }: { date: string }): ReactElement {
  const { settings } = useSettings()
  const { navigate } = useRouter()
  const [capturing, setCapturing] = useState(false)
  // Live: the Today affordance appears at midnight without a re-navigation.
  const isToday = date === useToday()

  return (
    <div className="flex h-dvh w-screen flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-1 pb-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Previous day"
          onClick={() => navigate({ kind: 'daily', date: addDaysIso(date, -1) })}
        >
          <ChevronLeft />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-center text-base font-semibold">
          {formatDayLabel(date, settings.dateFormat)}
        </h1>
        {!isToday && (
          <Button variant="ghost" size="sm" onClick={() => navigate({ kind: 'today' })}>
            Today
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Next day"
          onClick={() => navigate({ kind: 'daily', date: addDaysIso(date, 1) })}
        >
          <ChevronRight />
        </Button>
      </header>
      <main
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))' }}
      >
        <NotePane path={dailyPath(date)} lazy gutterClassName="px-4" editorClassName="min-h-[60dvh]" />
      </main>
      <Button
        size="icon"
        aria-label="Quick capture"
        className="fixed right-4 z-40 size-12 rounded-full shadow-lg"
        style={{ bottom: 'calc(max(env(safe-area-inset-bottom), var(--keyboard-height, 0px)) + 1rem)' }}
        onClick={() => setCapturing(true)}
      >
        <Plus className="size-6" />
      </Button>
      <CaptureSheet open={capturing} onOpenChange={setCapturing} />
    </div>
  )
}
