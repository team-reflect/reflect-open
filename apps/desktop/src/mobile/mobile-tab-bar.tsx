import { type ReactElement } from 'react'
import { Files, SquarePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'

export type MobileTab = 'daily' | 'all'

interface MobileTabBarProps {
  tab: MobileTab
  onSelect: (tab: MobileTab) => void
}

/**
 * The V1-parity bottom tab bar: Daily (the chronological spine) and All
 * (every note + search). It sits at the very bottom of the shell — the
 * software keyboard simply covers it, as in V1; screens pad their own scroll
 * containers via `--keyboard-height` instead.
 */
export function MobileTabBar({ tab, onSelect }: MobileTabBarProps): ReactElement {
  return (
    <nav
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
      // V1 parity: a light haptic on every tab press — including a re-press
      // of the active tab, which is the jump-to-today gesture on Daily.
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
