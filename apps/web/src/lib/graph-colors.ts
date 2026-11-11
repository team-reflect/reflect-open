import { GRAPH_COLOR_IDS, type GraphColor } from '@reflect/core'

/**
 * Presentation for the graph identity colors (`graphColors` in settings).
 * The ids and their order come from `@reflect/core`; this module owns how
 * each id renders. `indigo` is the default and resolves through the live
 * `--accent` token so it tracks the light/dark theme like the rest of the
 * chrome; the other hues are fixed mid-range values (the design system
 * deliberately has no ramps beyond indigo) chosen to read on both themes.
 */

/** The color a graph shows before the user picks one. */
export const DEFAULT_GRAPH_COLOR: GraphColor = 'indigo'

const GRAPH_COLOR_CSS: Record<GraphColor, string> = {
  indigo: 'var(--accent)',
  blue: '#3b82f6',
  teal: '#14b8a6',
  green: '#22c55e',
  amber: '#f59e0b',
  orange: '#f97316',
  red: '#ef4444',
  pink: '#ec4899',
  purple: '#a855f7',
}

const GRAPH_COLOR_LABELS: Record<GraphColor, string> = {
  indigo: 'Indigo',
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  amber: 'Amber',
  orange: 'Orange',
  red: 'Red',
  pink: 'Pink',
  purple: 'Purple',
}

/** A picker entry: the color id, its display label, and its CSS value. */
export interface GraphColorOption {
  id: GraphColor
  label: string
  css: string
}

/** Every graph color as a picker option, in display order. */
export const GRAPH_COLOR_OPTIONS: GraphColorOption[] = GRAPH_COLOR_IDS.map((id) => ({
  id,
  label: GRAPH_COLOR_LABELS[id],
  css: GRAPH_COLOR_CSS[id],
}))

/** The CSS color for a graph color id; `undefined` means the default. */
export function graphColorCss(color: GraphColor | undefined): string {
  return GRAPH_COLOR_CSS[color ?? DEFAULT_GRAPH_COLOR]
}
