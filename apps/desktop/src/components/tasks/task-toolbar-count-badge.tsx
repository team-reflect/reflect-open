import { type ReactElement } from 'react'
import { Badge } from '@/components/ui/badge'

interface TaskToolbarCountBadgeProps {
  /** Number of tasks affected by the adjacent toolbar action. */
  readonly count: number
}

/** Compact neutral count badge for task toolbar actions. */
export function TaskToolbarCountBadge({ count }: TaskToolbarCountBadgeProps): ReactElement {
  return (
    <Badge
      variant="outline"
      className="h-4 min-w-4 rounded-full border-transparent bg-muted px-1 text-[10px] font-medium leading-none text-muted-foreground tabular-nums"
    >
      {count}
    </Badge>
  )
}
