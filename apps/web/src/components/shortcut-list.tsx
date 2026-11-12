import type { ReactElement } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import type { Shortcut } from '@/lib/shortcuts.ts'
import { cn } from '@/lib/utils.ts'
import { useAppServices } from '@/services/services-provider.tsx'

interface ShortcutListProps {
  /** Group heading (a keymap scope: "App", "Editor"). */
  heading: string
  shortcuts: Shortcut[]
  /** Wrapper spacing — the settings card and the ⌘/ dialog pad differently. */
  className?: string
  /** Responsive column utilities for dense surfaces such as the ⌘/ dialog. */
  listClassName?: string
}

/**
 * One headed group of shortcut rows — description left, keycaps right — shared
 * by the Keyboard settings section and the ⌘/ cheat-sheet so the two surfaces
 * can't drift in either content or idiom.
 */
export function ShortcutList({
  heading,
  shortcuts,
  className,
  listClassName,
}: ShortcutListProps): ReactElement {
  const { keymap } = useAppServices()
  return (
    <div className={className}>
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
        {heading}
      </h3>
      <ul className={cn('mt-1.5', listClassName)}>
        {shortcuts.map(({ binding, description }) => (
          <li
            key={binding}
            className="flex break-inside-avoid items-center justify-between gap-4 py-1.5 text-sm text-text-secondary"
          >
            <span className="min-w-0 truncate">{description}</span>
            {/* The keycaps are aria-hidden decoration; this carries the binding for AT. */}
            <span className="sr-only">{keymap.formatLabel(binding)}</span>
            <ShortcutKeys binding={binding} />
          </li>
        ))}
      </ul>
    </div>
  )
}
