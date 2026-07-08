import type { ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { visibleTaskBreadcrumbs } from '@/lib/tasks/task-breadcrumbs'
import { cn } from '@/lib/utils'

interface TaskBreadcrumbsProps {
  breadcrumbs: readonly string[]
  className?: string
}

export function TaskBreadcrumbs({
  breadcrumbs,
  className,
}: TaskBreadcrumbsProps): ReactElement | null {
  const visible = visibleTaskBreadcrumbs(breadcrumbs)
  if (visible.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'mb-1 flex min-w-0 items-center gap-1 text-xs leading-5 text-text-muted/80',
        className,
      )}
    >
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
