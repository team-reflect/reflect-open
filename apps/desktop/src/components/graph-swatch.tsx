import type { ReactElement } from 'react'
import type { GraphColor } from '@reflect/core'
import { graphColorCss } from '@/lib/graph-colors'
import { cn } from '@/lib/utils'

interface GraphSwatchProps {
  /** The graph's chosen color; `undefined` renders the default (app accent). */
  color?: GraphColor
  /** Size (and shape overrides) — the swatch has no intrinsic dimensions. */
  className?: string
}

/**
 * A graph's identity color as a small rounded square — the visual anchor for
 * "which graph is this" in the sidebar footer, the graph switcher, and the
 * color picker. Decorative: always paired with the graph's name.
 */
export function GraphSwatch({ color, className }: GraphSwatchProps): ReactElement {
  return (
    <span
      aria-hidden
      className={cn('flex-none rounded-md', className)}
      style={{ backgroundColor: graphColorCss(color) }}
    />
  )
}
