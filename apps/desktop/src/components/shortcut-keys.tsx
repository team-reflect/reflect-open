import { useMemo, type ReactElement } from 'react'
import { Kbd } from '@/components/kbd'
import { formatBinding, isApplePlatform } from '@/lib/keybindings'
import { cn } from '@/lib/utils'

interface ShortcutKeysProps {
  /** A keymap-registry binding, e.g. `Mod-d` or `Mod-\`. */
  binding: string
  className?: string
}

/**
 * Renders a registry binding as a row of keycaps (⌘ D on Apple, Ctrl D
 * elsewhere). The display half of the central keymap registry — every surface
 * that hints a shortcut (sidebar, palette, settings cheat sheet) goes through
 * this so bindings always read the same way.
 */
export function ShortcutKeys({ binding, className }: ShortcutKeysProps): ReactElement {
  const keys = useMemo(() => formatBinding(binding, isApplePlatform()), [binding])
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 gap-[3px]', className)}>
      {keys.map((key, index) => (
        <Kbd key={index}>{key}</Kbd>
      ))}
    </span>
  )
}
