import type { ReactElement } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { cn } from '@/lib/utils'

interface SidebarItemProps {
  icon: LucideIcon
  label: string
  /** Keymap binding hinted on hover/focus (e.g. `Mod-d`). */
  binding?: string
  active?: boolean
  onClick: () => void
}

/**
 * One primary-navigation row, in the original sidebar's idiom: icon + medium
 * label on a translucent hover wash, accent-tinted when active, with the
 * keyboard shortcut revealed on hover — chrome that teaches the fast path.
 */
export function SidebarItem({
  icon: Icon,
  label,
  binding,
  active = false,
  onClick,
}: SidebarItemProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium',
        'transition-colors duration-100',
        active
          ? 'bg-[var(--surface-hover)] text-[color:var(--accent)] dark:text-[color:var(--accent-hover)]'
          : 'text-[color:var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[color:var(--text)]',
      )}
    >
      <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {binding ? (
        <ShortcutKeys
          binding={binding}
          className="opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      ) : null}
    </button>
  )
}
