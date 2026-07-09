import type { ReactElement } from 'react'
import { visibleTaskBreadcrumbs } from '@reflect/core'

interface TaskBreadcrumbsProps {
  breadcrumbs: readonly string[]
  /** Select every task row sharing this outline context. */
  onSelect: () => void
}

/** One V1-style outline-context row above the consecutive tasks it labels. */
export function TaskBreadcrumbs({
  breadcrumbs,
  onSelect,
}: TaskBreadcrumbsProps): ReactElement | null {
  const visible = visibleTaskBreadcrumbs(breadcrumbs)
  if (visible.length === 0) {
    return null
  }
  const label = visible.join(' → ')

  return (
    <li className="min-w-0 px-4 pt-1.5 lg:px-12">
      <button
        type="button"
        title={label}
        onClick={onSelect}
        className="block max-w-full truncate text-left text-xs leading-5 text-text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none"
      >
        {label}
      </button>
    </li>
  )
}
