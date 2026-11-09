import type { CSSProperties, ReactElement } from 'react'
import { Check } from 'lucide-react'
import type { WhatsNewItem } from '@reflect/app'
import { cn } from '@/lib/utils.ts'

/**
 * The class and style that rise a line in after `index` earlier lines.
 */
export function riseIn(index: number): { className: string; style: CSSProperties } {
  return {
    className:
      'animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 ease-out motion-reduce:animate-none',
    style: { animationDelay: `${150 + index * 70}ms` },
  }
}

interface WhatsNewItemsProps {
  readonly items: readonly WhatsNewItem[]
  /**
   * The stagger index of the first item. Without it the items do not animate.
   */
  readonly riseFrom?: number
  readonly className?: string
}

/**
 * The What's New items as a checked list with hairline dividers.
 */
export function WhatsNewItems({ items, riseFrom, className }: WhatsNewItemsProps): ReactElement {
  return (
    <ul className={cn('flex flex-col divide-y divide-border', className)}>
      {items.map((item, index) => {
        const rise = riseFrom === undefined ? undefined : riseIn(riseFrom + index)
        return (
          <li key={item.id} className={cn('flex gap-3 py-3', rise?.className)} style={rise?.style}>
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/10 text-accent dark:bg-accent/20 dark:text-accent-hover">
              <Check className="size-3.5" strokeWidth={2.75} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="leading-6 font-medium text-text">{item.title}</p>
              <p className="leading-snug text-text-secondary">{item.body}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
