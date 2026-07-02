import { useState, type ReactElement } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import {
  UPDATED_PRESETS,
  updatedPresetFilter,
  updatedRangeFilter,
  type UpdatedFilter,
} from './filter-state'

interface UpdatedFilterDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: UpdatedFilter | null
  onApply: (filter: UpdatedFilter | null) => void
}

/**
 * The Updated badge's picker (V1's date filter as a bottom sheet): relative
 * presets plus a custom from/to range (native date inputs — the OS date wheel
 * on mobile). The end date is inclusive.
 */
export function UpdatedFilterDrawer({
  open,
  onOpenChange,
  current,
  onApply,
}: UpdatedFilterDrawerProps): ReactElement {
  const [fromIso, setFromIso] = useState('')
  const [toIso, setToIso] = useState('')

  // Closing always drops the date inputs — a dismissed half-typed range must
  // not resurface on the next open as if it were still intended.
  const setOpen = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setFromIso('')
      setToIso('')
    }
    onOpenChange(nextOpen)
  }

  const apply = (filter: UpdatedFilter | null): void => {
    onApply(filter)
    setOpen(false)
  }

  const range = updatedRangeFilter(fromIso, toIso)

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerContent>
        <DrawerTitle>Updated</DrawerTitle>
        <div className="flex flex-col">
          {UPDATED_PRESETS.map(({ preset, label }) => (
            <button
              key={preset}
              type="button"
              onClick={() => apply(updatedPresetFilter(preset))}
              className="flex h-12 w-full items-center border-b border-border text-left text-base"
            >
              <span className="min-w-0 flex-1">{label}</span>
              {current?.label === label && <Check className="size-4 text-primary" />}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="Updated from"
            value={fromIso}
            onChange={(event) => setFromIso(event.target.value)}
            className="text-base"
          />
          <span className="text-xs text-text-muted">to</span>
          <Input
            type="date"
            aria-label="Updated to"
            value={toIso}
            onChange={(event) => setToIso(event.target.value)}
            className="text-base"
          />
        </div>
        <Button disabled={range === null} onClick={() => apply(range)}>
          Apply range
        </Button>
        {current !== null && (
          <Button variant="ghost" onClick={() => apply(null)}>
            Clear filter
          </Button>
        )}
      </DrawerContent>
    </Drawer>
  )
}
