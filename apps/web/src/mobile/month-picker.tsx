import { lazy, Suspense, useState, type ReactElement, type ReactNode } from 'react'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'

const MonthPickerDrawer = lazy(async () => {
  const { MonthPickerDrawer } = await import('@/mobile/month-picker-drawer.tsx')
  return { default: MonthPickerDrawer }
})

function detectMonthInput(): boolean {
  const input = document.createElement('input')
  input.type = 'month'
  return input.type === 'month'
}

const supportsMonthInput = detectMonthInput()

interface MonthPickerProps {
  /** The strip header's `YYYY-MM` month. */
  month: string
  /** The selection's `YYYY-MM` month. */
  selected: string
  /** Today's `YYYY-MM` month. */
  today: string
  /** Pick a `YYYY-MM` month. */
  onPick: (month: string) => void
  /** The trigger's content: the month title. */
  children: ReactNode
}

/**
 * The month title as a month picker: the browser's native month input where
 * it has one (the iOS month wheel), else the month picker sheet.
 */
export function MonthPicker(props: MonthPickerProps): ReactElement {
  if (supportsMonthInput) {
    return <NativeMonthPicker {...props} />
  }
  return <SheetMonthPicker {...props} />
}

function NativeMonthPicker({ selected, onPick, children }: MonthPickerProps): ReactElement {
  return (
    <label className="relative flex min-w-0 items-center gap-1">
      {children}
      <input
        type="month"
        aria-label="Change month"
        value={selected}
        // iOS opens the picker on focus; desktop Chrome only from its icon.
        onClick={(event) => event.currentTarget.showPicker()}
        onChange={(event) => {
          const picked = event.currentTarget.value
          // Desktop Chrome's Clear button empties the value.
          if (picked !== '') {
            onPick(picked)
          }
        }}
        className="absolute inset-0 appearance-none text-base opacity-0"
      />
    </label>
  )
}

function SheetMonthPicker({
  month,
  selected,
  today,
  onPick,
  children,
}: MonthPickerProps): ReactElement {
  const { haptics } = useMobileServices()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label="Change month"
        className="flex min-w-0 items-center gap-1"
        onClick={() => {
          hapticImpactLight(haptics)
          setOpen(true)
        }}
      >
        {children}
      </button>
      <Suspense fallback={null}>
        <MonthPickerDrawer
          open={open}
          onOpenChange={setOpen}
          month={month}
          selected={selected}
          today={today}
          onPick={(picked) => {
            setOpen(false)
            onPick(picked)
          }}
        />
      </Suspense>
    </>
  )
}
