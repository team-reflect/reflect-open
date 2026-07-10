import { useCallback, type ReactElement } from 'react'
import { untitledNotePath } from '@reflect/core'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToday } from '@/lib/use-today'
import { AudioMemoFab } from '@/mobile/audio-memo-fab'
import { CalendarStrip } from '@/mobile/calendar-strip'
import { DayCarousel } from '@/mobile/day-carousel'
import { useDailyArrivals } from '@/mobile/use-daily-arrivals'
import { useSwipeTarget } from '@/mobile/use-swipe-target'
import { useRouter } from '@/routing/router'

/**
 * The mobile spine (Plan 19, V1 parity): a month header + week calendar strip
 * over a swipeable day carousel of daily notes. The strip and the carousel
 * stay in lockstep through `date` — tapping a strip day or swiping the
 * carousel both navigate a daily route, which flows back as `date` (though
 * mid-swipe the strip briefly leads, following the gesture's target day). The
 * new-note button floats above it all (V1: the daily note is the capture
 * surface; `+` opens a fresh untitled note via desktop's ⌘N seed flow).
 *
 * Mounted once for the daily surface (a stable key in `MobileScreen`), so a
 * day change scrolls the carousel rather than remounting it.
 */
export function MobileDaily({ date }: { date: string }): ReactElement {
  const { navigate, entryId, arrivalSeq, arrivalFocusEditor } = useRouter()
  // One live `today` for the whole surface: the strip marks today's cell and
  // the `select` below decide "is this today?" from the *same* value, so they
  // can't disagree across the midnight rollover (which would otherwise route a
  // tap on the highlighted today cell to a frozen `daily` date). Selecting
  // today routes to the live `today` route, keeping the spine rolling over.
  const today = useToday()
  // The identity of the current router arrival. Every navigate bumps
  // `arrivalSeq` (history moves change `entryId`), so any arrival — including
  // a date-preserving Today tap — mints a new key, which supersedes the swipe
  // state scoped to the old one.
  const navigationKey = `${entryId}:${arrivalSeq}:${date}`
  // The day a swipe is heading toward, announced at pointer-up — the strip
  // (and its rolling month title) follows it while the carousel's snap
  // animation plays, instead of waiting for the settle-time route change.
  const { targetDate, followSwipeTarget } = useSwipeTarget(navigationKey)
  const select = useCallback(
    (day: string): void => {
      navigate(day === today ? { kind: 'today' } : { kind: 'daily', date: day })
    },
    [navigate, today],
  )

  // An explicit re-arrival at the day already shown — the Daily tab tapped
  // while on today (V1's double-tap-to-today lands here) — re-anchors the
  // surface, and a capture arrival focuses the day's editor; the arrival
  // bookkeeping (including a focus request racing this surface's remount)
  // lives in use-daily-arrivals.ts.
  const { resetSeq, focusDate, consumeFocus } = useDailyArrivals({
    arrivalSeq,
    arrivalFocusEditor,
    date,
  })

  return (
    <div className="flex h-full w-screen flex-col">
      <CalendarStrip date={targetDate ?? date} today={today} resetSeq={resetSeq} onSelect={select} />
      <DayCarousel
        date={date}
        today={today}
        scrollResetSeq={resetSeq}
        navigationKey={navigationKey}
        focusDate={focusDate}
        onFocusConsumed={consumeFocus}
        onSelect={select}
        onTarget={followSwipeTarget}
      />
      <Button
        size="icon"
        aria-label="New note"
        className="fixed right-4 z-40 size-12 rounded-full shadow-lg"
        style={{ bottom: 'calc(max(env(safe-area-inset-bottom), var(--keyboard-height, 0px)) + 4.25rem)' }}
        onClick={() => navigate({ kind: 'note', path: untitledNotePath() })}
      >
        <Plus className="size-6" />
      </Button>
      <AudioMemoFab />
    </div>
  )
}
