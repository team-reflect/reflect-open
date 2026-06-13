import { type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { untitledNotePath } from '@/lib/create-note'
import { useToday } from '@/lib/use-today'
import { CalendarStrip } from '@/mobile/calendar-strip'
import { DayCarousel } from '@/mobile/day-carousel'
import { useRouter } from '@/routing/router'

/**
 * The mobile spine (Plan 19, V1 parity): a month header + week calendar strip
 * over a swipeable day carousel of daily notes. The strip and the carousel
 * stay in lockstep through `date` — tapping a strip day or swiping the
 * carousel both navigate a daily route, which flows back as `date`. The
 * new-note button floats above it all (V1: the daily note is the capture
 * surface; `+` opens a fresh untitled note via desktop's ⌘N seed flow).
 *
 * Mounted once for the daily surface (a stable key in `MobileScreen`), so a
 * day change scrolls the carousel rather than remounting it.
 */
export function MobileDaily({ date }: { date: string }): ReactElement {
  const { navigate } = useRouter()
  // One live `today` for the whole surface: the strip marks today's cell and
  // the `select` below decide "is this today?" from the *same* value, so they
  // can't disagree across the midnight rollover (which would otherwise route a
  // tap on the highlighted today cell to a frozen `daily` date). Selecting
  // today routes to the live `today` route, keeping the spine rolling over.
  const today = useToday()
  const select = (day: string): void =>
    navigate(day === today ? { kind: 'today' } : { kind: 'daily', date: day })

  return (
    <div className="flex h-full w-screen flex-col">
      <CalendarStrip date={date} today={today} onSelect={select} />
      <DayCarousel date={date} today={today} onSelect={select} />
      <Button
        size="icon"
        aria-label="New note"
        className="fixed right-4 z-40 size-12 rounded-full shadow-lg"
        style={{ bottom: 'calc(max(env(safe-area-inset-bottom), var(--keyboard-height, 0px)) + 4.25rem)' }}
        onClick={() => navigate({ kind: 'note', path: untitledNotePath() })}
      >
        <Plus className="size-6" />
      </Button>
    </div>
  )
}
