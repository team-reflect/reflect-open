import { useEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Link2, Trash2 } from 'lucide-react'
import type { AnnotationItem } from '@/lib/annotations/annotations-store'
import { cn } from '@/lib/utils'

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

/** How far the menu's corner can sit from the viewport edge before it flips. */
const VIEWPORT_MARGIN_PX = 8

/**
 * The small menu that opens on a right-clicked annotation rect — the app-side
 * equivalent of SiYuan's annotation popup, trimmed to the three actions that
 * map onto Reflect: copy the annotation's text, copy a markdown reference back
 * to its PDF page, and delete the annotation. Positioned at the cursor, closed
 * by Escape, a click outside, or any action. The visual language mirrors the
 * app's dropdown menu (`bg-popover`, ring, quiet menu items); the actions
 * themselves are the caller's business — this component only wires the UI.
 */
export function AnnotationContextMenu({
  anchor,
  onClose,
  onCopyText,
  onCopyReference,
  onRemove,
}: AnnotationContextMenuProps): ReactElement | null {
  // The menu's own corner when closing a portal is the same element; a
  // document pointerdown closes it, so the menu must not swallow the very
  // click that opened it (the click lands before this mount).
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (anchor === null) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    // 菜单由 contextmenu（右键）打开，那次交互的 pointerdown 已先发生，这里
    // 直接挂全局监听不会立刻把自己关掉。
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, onClose])

  if (anchor === null) {
    return null
  }
  const { x, y, item } = anchor
  // 贴近光标，但在窗口边缘翻折，避免菜单被裁掉。
  const left = Math.min(x, window.innerWidth - VIEWPORT_MARGIN_PX - 176)
  const top = Math.min(y, window.innerHeight - VIEWPORT_MARGIN_PX - 120)

  const menuItemClass =
    'group/annotation-menu-item flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 ' +
    'text-sm text-text outline-hidden select-none focus:bg-surface-hover focus:text-text ' +
    'data-disabled:pointer-events-none data-disabled:opacity-50'

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Annotation actions"
      className="fixed z-50 w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left, top }}
    >
      <button
        type="button"
        role="menuitem"
        className={menuItemClass}
        // 空文本的 border 标注可从矩形覆盖区域提取文本，因此不禁用；仅
        // text 类型标注无文本时禁用（提取不到，点了也是状态栏提示）。
        disabled={item.text.trim() === '' && item.type !== 'border'}
        onClick={() => {
          onCopyText(item)
          onClose()
        }}
      >
        <Copy />
        <span className="min-w-0 flex-1 truncate text-left">Copy text</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={menuItemClass}
        onClick={() => {
          onCopyReference(item)
          onClose()
        }}
      >
        <Link2 />
        <span className="min-w-0 flex-1 truncate text-left">Copy reference</span>
      </button>
      <div className={cn('-mx-1 my-1 h-px bg-border')} role="separator" />
      <button
        type="button"
        role="menuitem"
        className={cn(menuItemClass, 'text-destructive focus:bg-destructive/10')}
        onClick={() => {
          onRemove(item.id)
          onClose()
        }}
      >
        <Trash2 />
        <span className="min-w-0 flex-1 truncate text-left">Delete</span>
      </button>
    </div>,
    document.body,
  )
}
