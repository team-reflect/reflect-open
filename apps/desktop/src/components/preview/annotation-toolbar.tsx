import type { ReactElement } from 'react'
import { MousePointer, PanelBottomClose, PanelBottomOpen, SquareDashed, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** The sidebar's interaction mode: browse (click annotations) or draw new ones. */
export type AnnotationTool = 'browse' | 'create'

/**
 * Colors new annotations get, matching the classic PDF highlight palette the
 * migration sidecar's colors are drawn from. Existing annotations always keep
 * their own color; this list only seeds the picker and new draws.
 */
export const ANNOTATION_COLORS = [
  '#FFD400', // yellow
  '#8CE99A', // green
  '#74C0FC', // blue
  '#FAA2C1', // pink
  '#B197FC', // purple
] as const

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]

/** The yellow picker color new annotations default to. */
export const DEFAULT_ANNOTATION_COLOR = '#FFD400'

interface AnnotationToolbarProps {
  mode: AnnotationTool
  onModeChange: (mode: AnnotationTool) => void
  color: AnnotationColor
  onColorChange: (color: AnnotationColor) => void
  /** Id of the annotation selected in the list/layer; null disables delete. */
  selectedId: string | null
  onDeleteSelected: () => void
  /** Whether the annotation list below is collapsed to just this row. */
  collapsed: boolean
  /** Collapse/expand the list; never closes the panel. */
  onToggleCollapsed: () => void
}

/**
 * The annotation tools row under the PDF viewer: browse/draw mode switch, the
 * color palette for new annotations, delete-selected, and the list's
 * collapse/expand toggle. The trailing button only folds the annotation list —
 * closing the whole panel lives in the viewer's own chrome (the page toolbar's
 * X). Styled to match the context sidebar chrome (`text-text`, `border-border`,
 * quiet icon buttons) rather than inventing a new surface.
 */
export function AnnotationToolbar({
  mode,
  onModeChange,
  color,
  onColorChange,
  selectedId,
  onDeleteSelected,
  collapsed,
  onToggleCollapsed,
}: AnnotationToolbarProps): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-1.5 py-1">
      <Button
        variant={mode === 'browse' ? 'secondary' : 'ghost'}
        size="icon-sm"
        aria-label="Browse (v)"
        aria-pressed={mode === 'browse'}
        title="Browse (v)"
        onClick={() => onModeChange('browse')}
      >
        <MousePointer />
      </Button>
      <Button
        variant={mode === 'create' ? 'secondary' : 'ghost'}
        size="icon-sm"
        aria-label="Draw rectangle (r)"
        aria-pressed={mode === 'create'}
        title="Draw rectangle (r)"
        onClick={() => onModeChange('create')}
      >
        <SquareDashed />
      </Button>

      <span className="mx-1 h-4 w-px bg-border" aria-hidden />

      {ANNOTATION_COLORS.map((swatch) => (
        <button
          key={swatch}
          type="button"
          aria-label={`Annotation color ${swatch}`}
          aria-pressed={color === swatch}
          className={cn(
            'size-4 rounded-sm border border-black/10 transition-shadow',
            'hover:ring-2 hover:ring-ring/60',
            color === swatch && 'ring-2 ring-ring ring-offset-1 ring-offset-surface-sunken',
          )}
          style={{ backgroundColor: swatch }}
          onClick={() => onColorChange(swatch)}
        />
      ))}

      <span className="mx-1 h-4 w-px bg-border" aria-hidden />

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Delete annotation"
        title="Delete annotation"
        disabled={selectedId === null}
        onClick={onDeleteSelected}
      >
        <Trash2 />
      </Button>

      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        aria-label={collapsed ? 'Expand annotation list' : 'Collapse annotation list'}
        aria-pressed={!collapsed}
        title={collapsed ? 'Expand annotation list' : 'Collapse annotation list'}
        onClick={onToggleCollapsed}
      >
        {collapsed ? <PanelBottomOpen /> : <PanelBottomClose />}
      </Button>
    </div>
  )
}
