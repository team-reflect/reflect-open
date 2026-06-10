import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useRouter } from './router'

interface ScrollRestoredProps {
  className?: string
  children: ReactNode
}

/**
 * A scroll container wired to the router's per-entry scroll memory (Plan 06b):
 * it reports its offset as the user scrolls and restores the saved offset when
 * a history entry is revisited via back/forward. The daily stream does the same
 * through its virtualizer; this is for plain views (note, search).
 *
 * The container is positioned (`relative`) so absolutely-positioned
 * descendants — `sr-only` controls especially — resolve against it and scroll
 * with the content. Without it they escape to the workspace column at their
 * static offsets, overflowing the frame into a second scrollbar.
 */
export function ScrollRestored({ className, children }: ScrollRestoredProps): ReactElement {
  const { entryId, saveScrollState, savedScroll } = useRouter()
  const ref = useRef<HTMLDivElement | null>(null)

  // Re-run whenever the history entry changes (back/forward, or note→note in
  // the same mounted container): restore the entry's offset, or reset to the
  // top for an entry that has none — never carry the previous view's position.
  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = savedScroll() ?? 0
    }
  }, [entryId, savedScroll])

  return (
    <div
      ref={ref}
      className={cn(className, 'relative')}
      onScroll={(event) => saveScrollState(event.currentTarget.scrollTop)}
    >
      {children}
    </div>
  )
}
