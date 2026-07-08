import type { ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { visibleTaskBreadcrumbs } from '@/lib/tasks/task-breadcrumbs'

interface TaskBreadcrumbsProps {
  breadcrumbs: readonly string[]
}

export function TaskBreadcrumbs({ breadcrumbs }: TaskBreadcrumbsProps): ReactElement | null {
  const visible = visibleTaskBreadcrumbs(breadcrumbs)
  if (visible.length === 0) {
    return null
  }

  return (
    <div className="mb-1 flex min-w-0 items-center gap-1 text-xs leading-5 text-text-muted/80">
      {visible.map((part, index) => (
        <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 shrink-0 text-text-muted/55" />
          ) : null}
          <span className="truncate">{part}</span>
        </span>
      ))}
    </div>
  )
}
