import { useState, type ReactElement, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface SidebarSectionProps {
  /** Session-storage key suffix persisting this section's open state. */
  storageKey: string
  title: string
  /** Optional count rendered after the title (e.g. backlink total). */
  count?: number
  children: ReactNode
}

const STORAGE_PREFIX = 'reflect.context-sidebar.'

function readOpenState(storageKey: string): boolean {
  return window.sessionStorage.getItem(STORAGE_PREFIX + storageKey) !== 'closed'
}

/**
 * One collapsible sidebar section (the old app's `SidebarItem` shape): a
 * header row with a disclosure chevron, open by default, open/closed state
 * persisted per section for the session so a collapsed section stays
 * collapsed while navigating between days and notes.
 */
export function SidebarSection({
  storageKey,
  title,
  count,
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
    <section className="border-b border-black/5 py-1 dark:border-white/5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-left hover:bg-surface-hover"
      >
        <Chevron aria-hidden className="size-3 text-text-muted" />
        <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {title}
        </span>
        {count !== undefined && count > 0 ? (
          <span className="text-xs tabular-nums text-text-muted">{count}</span>
        ) : null}
      </button>
      {open ? <div className="px-2 pb-2">{children}</div> : null}
    </section>
  )
}
