import { useMemo, type ReactElement } from 'react'
import { KBD_FRAME_CLASS } from '@/components/kbd'
import { formatBinding, isApplePlatform } from '@/lib/keybindings'
import { cn } from '@/lib/utils'

interface ShortcutKeysProps {
  /** A keymap-registry binding, e.g. `Mod-d` or `Mod-\`. */
  binding: string
  /** Render as borderless inline text (V1's search-bar ⌘K) instead of a keycap pill. */
  ghost?: boolean
  className?: string
}

/**
 * Renders a registry binding in the V1 idiom: all keys grouped inside a
 * single bordered pill (⌘D on Apple, Ctrl D elsewhere), not one keycap per
 * key. The display half of the central keymap registry — every surface that
 * hints a shortcut (sidebar, palette, settings cheat sheet) goes through
 * this so bindings always read the same way.
 */
export function ShortcutKeys({ binding, ghost, className }: ShortcutKeysProps): ReactElement {
  const keys = useMemo(() => formatBinding(binding, isApplePlatform()), [binding])
  if (ghost) {
    return (
      <span
        aria-hidden
        className={cn('shrink-0 font-shortcut text-2xs uppercase', className)}
      >
        {keys.join('')}
      </span>
    )
  }
  return (
    <span aria-hidden className={cn(KBD_FRAME_CLASS, 'shrink-0', className)}>
      {keys.map((key, index) => (
        <kbd
          key={index}
          className={cn(
            'block text-center font-shortcut leading-4',
            key.length === 1 ? '-mx-0.5 min-w-[1lh]' : 'mx-0.5',
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
