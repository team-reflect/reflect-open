import { useState, type ReactElement, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarSectionProps {
  /** Session-storage key suffix persisting this section's open state. */
  storageKey: string
  title: string
  children: ReactNode
}

const STORAGE_PREFIX = 'reflect.context-sidebar.'

function readOpenState(storageKey: string): boolean {
  return window.sessionStorage.getItem(STORAGE_PREFIX + storageKey) !== 'closed'
}

/**
 * One collapsible sidebar section (the old app's `SidebarItem` shape): a
 * quiet sentence-case header whose disclosure chevron sits on the right and —
 * while the section is open — only appears on hover. Open by default,
 * open/closed state persisted per section for the session so a collapsed
 * section stays collapsed while navigating between days and notes.
 */
export function SidebarSection({
  storageKey,
  title,
  children,
}: SidebarSectionProps): ReactElement {
  const [open, setOpen] = useState(() => readOpenState(storageKey))

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    window.sessionStorage.setItem(STORAGE_PREFIX + storageKey, next ? 'open' : 'closed')
  }

  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group flex w-full items-center px-3.5 text-2xs font-medium text-text-muted"
      >
        <span className="flex-1 truncate text-left">{title}</span>
        <span className={cn('flex-none group-hover:visible', open && 'invisible')}>
          <Chevron aria-hidden className="size-3" />
        </span>
      </button>
      {open ? <div className="px-2">{children}</div> : null}
    </section>
  )
}
