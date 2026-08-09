import { useState, type ReactElement } from 'react'
import type { AnnotationItem } from '@/lib/annotations/annotations-store'
import { useListHeightResize } from '@/hooks/use-list-resize'
import { cn } from '@/lib/utils'
import { AnnotationList } from './annotation-list'
import { AnnotationToolbar, type AnnotationColor, type AnnotationTool } from './annotation-toolbar'

/** The annotation list element id, for the divider's `aria-controls`. */
const ANNOTATION_LIST_ID = 'annotation-list'

interface AnnotationSectionProps {
  annotations: readonly AnnotationItem[]
  mode: AnnotationTool
  onModeChange: (mode: AnnotationTool) => void
  color: AnnotationColor
  onColorChange: (color: AnnotationColor) => void
  selectedId: string | null
  onSelect: (id: string) => void
  onDeleteSelected: () => void
}

/**
 * The annotation index under the PDF pages: the tools row on top, the
 * collapsible list below. The list's height is user-adjustable — a quiet
 * divider on its top edge drags it taller/shorter (same texture as the
 * sidebar resize handles: hover/focus/drag indigo line, arrow-key nudges,
 * double-click reset), and the tools row's trailing button folds the list to
 * nothing. Only the viewer's own close button (the page toolbar's X) closes
 * the panel; this section never does.
 */
export function AnnotationSection({
  annotations,
  mode,
  onModeChange,
  color,
  onColorChange,
  selectedId,
  onSelect,
  onDeleteSelected,
}: AnnotationSectionProps): ReactElement {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex shrink-0 flex-col">
      <AnnotationToolbar
        mode={mode}
        onModeChange={onModeChange}
        color={color}
        onColorChange={onColorChange}
        selectedId={selectedId}
        onDeleteSelected={onDeleteSelected}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
      />
      {!collapsed ? (
        <div className="relative shrink-0">
          <AnnotationListResizeHandle />
          <div
            id={ANNOTATION_LIST_ID}
            className="h-[var(--annotation-list-height)] overflow-y-auto border-t border-border"
          >
            <AnnotationList annotations={annotations} selectedId={selectedId} onSelect={onSelect} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The divider on the annotation list's top edge: an 8px invisible hit strip
 * whose 2px edge line fades in on a lingered hover, while dragging, and on
 * keyboard focus — the horizontal mirror of `SidebarResizeHandle`'s texture.
 * The handle's parent carries the list's fixed height, so the drag rebases on
 * the rendered list height and the keyboard/`aria-value*` semantics follow
 * the window-splitter pattern (ArrowUp grows, ArrowDown shrinks, Home/End jump
 * to the bounds, double-click resets).
 */
function AnnotationListResizeHandle(): ReactElement {
  const { height, range, dragging, handlers } = useListHeightResize()

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize annotation list"
      aria-controls={ANNOTATION_LIST_ID}
      aria-valuenow={height}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      {...handlers}
      className={cn(
        // outline-hidden (not -none) keeps the forced-colors fallback outline
        // for high-contrast users, whom the tinted edge line cannot reach.
        'absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none outline-hidden',
        'after:absolute after:inset-x-0 after:top-1 after:h-0.5 after:bg-border-strong after:opacity-0 after:transition-opacity after:duration-150',
        'hover:after:opacity-60 hover:after:delay-300',
        'focus-visible:after:bg-accent focus-visible:after:opacity-40 focus-visible:after:delay-0',
        dragging && 'after:bg-accent after:opacity-60 hover:after:delay-0',
      )}
    />
  )
}
