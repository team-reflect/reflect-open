import type { ReactElement } from 'react'
import { SearchIcon } from '@/components/icons/search-icon'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { keybindingFor } from '@/lib/commands/app-commands'

const PALETTE_BINDING = keybindingFor('palette.open')

/**
 * The sidebar's search affordance, styled as the original app's search field —
 * but it's a button: all finding happens in the one ⌘K surface, so this just
 * opens it (and teaches the shortcut with V1's ghost ⌘K hint).
 */
export function SidebarSearch({ onOpen }: { onOpen: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-text items-center space-x-1 rounded-[7px] border border-border-strong bg-input-bg px-2 py-1.5 text-xs text-text-muted shadow-app-input transition duration-150 ease-in-out hover:text-text-secondary dark:hover:text-text"
    >
      <span className="flex-none">
        <SearchIcon />
      </span>
      <span className="w-0 flex-1 truncate text-left">Search anything...</span>
      {PALETTE_BINDING !== null ? <ShortcutKeys binding={PALETTE_BINDING} ghost /> : null}
    </button>
  )
}
