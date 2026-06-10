import type { ReactElement } from 'react'
import { Search } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'

/**
 * The sidebar's search affordance, styled as the original app's search field —
 * but it's a button: all finding happens in the one ⌘K surface, so this just
 * opens it (and teaches the shortcut with an always-visible keycap).
 */
export function SidebarSearch({ onOpen }: { onOpen: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-[7px] border border-[var(--border-strong)] bg-[var(--input-bg)] px-2.5 py-1.5 text-sm text-[color:var(--text-muted)] shadow-[var(--shadow-input)] transition-colors duration-100 hover:text-[color:var(--text-secondary)]"
    >
      <Search aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">Search anything…</span>
      <ShortcutKeys binding="Mod-k" />
    </button>
  )
}
