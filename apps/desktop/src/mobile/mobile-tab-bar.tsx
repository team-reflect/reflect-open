import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { CircleCheck, Files, MessageSquare, SquarePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'
import type { Route } from '@/routing/route'

export type MobileTab = 'daily' | 'all' | 'tasks' | 'chat'

/** The tab whose root screen a route shows, or `null` for stacked screens. */
export function tabRootFor(route: Route): MobileTab | null {
  switch (route.kind) {
    case 'today':
    case 'daily':
      return 'daily'
    case 'allNotes':
    case 'search':
      return 'all'
    case 'tasks':
      return 'tasks'
    case 'chat':
      return 'chat'
    default:
      return null
  }
}

interface MobileTabBarProps {
  tab: MobileTab
  onSelect: (tab: MobileTab) => void
}

/**
 * The V1-parity bottom tab bar: Daily (the chronological spine), All
 * (every note + search), and Tasks (every open checkbox, grouped). It sits at
 * the very bottom of the shell. In V1 the
 * software keyboard simply covered it; the shell root now ends at the
 * keyboard's top, so the shell hides the bar while the keyboard is up to
 * keep that behavior.
 *
 * The bar publishes its measured height as `--mobile-tab-bar-height` on the
 * document root, so viewport-anchored elements (the sync status pill) can
 * sit above it without hardcoding its size. The variable clears on unmount
 * (the keyboard-up state), leaving consumers their own fallback.
 */
export function MobileTabBar({ tab, onSelect }: MobileTabBarProps): ReactElement {
  const navRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const nav = navRef.current
    const root = document.documentElement
    if (nav === null) {
      return
    }
    const publish = (): void => {
      root.style.setProperty('--mobile-tab-bar-height', `${nav.offsetHeight}px`)
    }
    publish()
    // Content-sized: the height moves with rotation (safe-area padding).
    const observer = new ResizeObserver(publish)
    observer.observe(nav)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--mobile-tab-bar-height')
    }
  }, [])

  return (
    <nav
      ref={navRef}
      aria-label="Sections"
      className="flex shrink-0 border-t border-border"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <TabButton
        label="Daily"
        icon={<SquarePen className="size-5" />}
        active={tab === 'daily'}
        onClick={() => onSelect('daily')}
      />
      <TabButton
        label="All"
        icon={<Files className="size-5" />}
        active={tab === 'all'}
        onClick={() => onSelect('all')}
      />
      <TabButton
        label="Tasks"
        icon={<CircleCheck className="size-5" />}
        active={tab === 'tasks'}
        onClick={() => onSelect('tasks')}
      />
      <TabButton
        label="Chat"
        icon={<MessageSquare className="size-5" />}
        active={tab === 'chat'}
        onClick={() => onSelect('chat')}
      />
    </nav>
  )
}

function TabButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon: ReactElement
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      // V1 parity: a light haptic on every tab press, including the two taps
      // that make Daily's double-tap-to-today gesture.
      onClick={() => {
        hapticImpactLight()
        onClick()
      }}
      className={cn(
        'flex flex-1 flex-col items-center gap-0.5 pb-1 pt-2 text-[11px] font-medium',
        active ? 'text-primary' : 'text-text-muted',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
