import type { ReactElement } from 'react'
import { Copy, Link2, Trash2 } from 'lucide-react'
import type { AnnotationItem } from '@/lib/annotations/annotations-store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** Where a right-click opened the menu: the cursor position plus the annotation. */
export interface AnnotationMenuAnchor {
  x: number
  y: number
  item: AnnotationItem
}

interface AnnotationContextMenuProps {
  /** The open menu's anchor, or null to render nothing. */
  anchor: AnnotationMenuAnchor | null
  onClose: () => void
  onCopyText: (item: AnnotationItem) => void
  onCopyReference: (item: AnnotationItem) => void
  onRemove: (id: string) => void
}

/**
 * The menu that opens on a right-clicked annotation rect — the app-side
 * equivalent of SiYuan's annotation popup, trimmed to the three actions that
 * map onto Reflect: copy the annotation's text (extracted from the covered
 * region when a border annotation carries none), copy a markdown reference
 * back to its PDF page, and delete the annotation. Built on the shared shadcn
 * DropdownMenu: a zero-size anchor parked at the cursor anchors the popper,
 * whose collision handling replaces the hand-rolled viewport flip. The
 * annotation rects are raw DOM (highlight-layer), so the menu is controlled —
 * the layer sets `anchor` on contextmenu, and an action, Escape, or an outside
 * click closes it through `onClose`.
 */
export function AnnotationContextMenu({
  anchor,
  onClose,
  onCopyText,
  onCopyReference,
  onRemove,
}: AnnotationContextMenuProps): ReactElement | null {
  if (anchor === null) {
    return null
  }
  const { x, y, item } = anchor
  return (
    <DropdownMenu
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      {/* A zero-size anchor pinned to the cursor: the popper positions against
          it and flips itself at the viewport edges. A real <button> keeps the
          trigger's native-button semantics. */}
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }}
          />
        }
      />
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        aria-label="Annotation actions"
        className="w-44"
      >
        <DropdownMenuItem
          // An empty-text border annotation extracts its text from the covered
          // region, so only a text-type annotation with no text is disabled.
          disabled={item.text.trim() === '' && item.type !== 'border'}
          onClick={() => onCopyText(item)}
        >
          <Copy />
          Copy text
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCopyReference(item)}>
          <Link2 />
          Copy reference
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onRemove(item.id)}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
