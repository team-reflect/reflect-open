import { useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { monthLabel, monthShortLabel } from '@/lib/month-grid'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'

interface MonthPickerDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The strip header's `YYYY-MM` month — the year the sheet opens on. */
  month: string
  /** The selection's `YYYY-MM` month, shown filled like the strip's day. */
  selected: string
  /** Today's `YYYY-MM` month, marked like the strip's today cell. */
  today: string
  /** Pick a `YYYY-MM` month — the strip navigates and closes the sheet. */
  onPick: (month: string) => void
}

function yearOf(month: string): number {
  return Number(month.slice(0, 4))
}

/**
 * The month title's picker sheet: a year pager over a tap-to-jump grid of its
 * twelve months (iOS's compact date-picker idiom as a bottom sheet). Browsing
 * years never navigates — only tapping a month does; the sheet dismisses by
 * drag or tapping outside, like every mobile sheet.
 */
export function MonthPickerDrawer({
  open,
  onOpenChange,
  month,
  selected,
  today,
  onPick,
}: MonthPickerDrawerProps): ReactElement {
  const [year, setYear] = useState(() => yearOf(month))
  // Each open starts from the currently displayed month's year, not wherever
  // the previous visit browsed to. Adjust-on-render, mirroring MonthTitle.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setYear(yearOf(month))
    }
  }

  const months = Array.from(
    { length: 12 },
    (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`,
  )

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Change month">
        <DrawerTitle className="sr-only">Change month</DrawerTitle>
        <div className="flex items-center justify-between p-4">
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Previous year"
            onClick={() => setYear(year - 1)}
          >
            <ChevronLeft />
          </Button>
          <div className="text-base font-semibold tabular-nums">{year}</div>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Next year"
            onClick={() => setYear(year + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {months.map((candidate) => {
            const isSelected = candidate === selected
            const isThisMonth = candidate === today
            return (
              <button
                key={candidate}
                type="button"
                aria-label={monthLabel(candidate)}
                aria-pressed={isSelected}
                aria-current={isThisMonth ? 'date' : undefined}
                onClick={() => {
                  hapticImpactLight()
                  onPick(candidate)
                }}
                className={cn(
                  'h-11 rounded-lg text-sm',
                  isSelected && 'bg-primary font-semibold text-primary-foreground',
                  !isSelected && isThisMonth && 'font-semibold text-primary',
                  !isSelected && !isThisMonth && 'text-text',
                )}
              >
                {monthShortLabel(candidate)}
              </button>
            )
          })}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
