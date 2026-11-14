import type { ReactElement } from 'react'
import { CircleCheck, Files, SquarePen } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import type { Section } from '@reflect/app'

export type MobileTab = 'daily' | 'all' | 'tasks'

/**
 * The tab that lights for a history entry of `section`. Chat sits in the All
 * tab, where asking is next to searching.
 */
export function mobileTabForSection(section: Section): MobileTab {
  return section === 'chat' ? 'all' : section
}

const TABS = [
  { id: 'daily', label: 'Daily', Icon: SquarePen },
  { id: 'all', label: 'All', Icon: Files },
  { id: 'tasks', label: 'Tasks', Icon: CircleCheck },
] as const

interface TabCapsuleProps {
  tab: MobileTab
  onSelect: (tab: MobileTab) => void
}

/**
 * The Daily / All / Tasks capsule: Daily (the chronological spine), All
 * (every note + search), and Tasks (every open checkbox, grouped). Chat is
 * not a tab: it is a stacked screen reached from All, where asking sits next
 * to searching.
 */
export function TabCapsule({ tab, onSelect }: TabCapsuleProps): ReactElement {
  return (
    <nav
      aria-label="Sections"
      className="flex rounded-full bg-surface p-1 shadow-lg ring-1 ring-border"
    >
      {TABS.map(({ id, label, Icon }) => (
        <TabButton
          key={id}
          label={label}
          icon={<Icon className="size-5" />}
          active={tab === id}
          onClick={() => onSelect(id)}
        />
      ))}
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
  const { haptics } = useMobileServices()
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      // V1 parity: a light haptic on every tab press, including the two taps
      // that make Daily's double-tap-to-today gesture.
      onClick={() => {
        hapticImpactLight(haptics)
        onClick()
      }}
      className={cn(
        'flex h-14 w-16 flex-col items-center justify-center gap-0.5 rounded-full text-xs font-medium',
        active ? 'bg-muted text-primary' : 'text-text-muted',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
