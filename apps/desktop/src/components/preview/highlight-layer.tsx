import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactElement,
} from 'react'
import type { AnnotationItem } from '@/lib/annotations/annotations-store'
import type { AnnotationTool } from './annotation-toolbar'
import { AnnotationContextMenu, type AnnotationMenuAnchor } from './annotation-context-menu'
import { usePdfViewer } from './pdf-viewer-shell'

/**
 * A 0~1 normalized rectangle, top-left origin, y growing downward — i.e. the
 * page's display space, not PDF user space. This is the coordinate system
 * {@link AnnotationItem.rects} uses: `[x1, y1, x2, y2]` as fractions of the
 * page's rendered (CSS) dimensions. pdf.js's `convertToViewportRectangle` is
 * not involved because the values never leave display space: the overlay
 * positions each rect with percentages of the page element, which the viewer
 * rescales with the page on zoom, and drag-creation measures CSS pixels
 * against the page element and divides by its size.
 */
export type NormalizedRect = [number, number, number, number]

/** The overlay element class; the mutation observer ignores changes beneath it. */
const OVERLAY_CLASS = 'reflect-annotation-overlay'
/** A single annotation rectangle element class. */
const RECT_CLASS = 'reflect-annotation-rect'
/** Smaller drags (as a fraction of the page) are treated as misclicks. */
const MIN_NORMALIZED_SIZE = 0.01

interface Point {
  x: number
  y: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function normalizedRectFromPoints(start: Point, end: Point): NormalizedRect {
  return [
    Math.min(start.x, end.x),
    Math.min(start.y, end.y),
    Math.max(start.x, end.x),
    Math.max(start.y, end.y),
  ]
}

/** `0.25` -> `"25%"`, the unit annotation rects are laid out with. */
function percent(fraction: number): string {
  return `${fraction * 100}%`
}

/**
 * Read a stored rect as a 4-tuple, defaulting the missing members to zero so
 * a malformed (or empty) rect never crashes the layer. `noUncheckedIndexedAccess`
 * types every member as possibly-undefined, hence the per-member fallback.
 */
function rectTuple(rect: readonly number[] | undefined): [number, number, number, number] {
  const [left, top, right, bottom] = rect ?? []
  return [left ?? 0, top ?? 0, right ?? 0, bottom ?? 0]
}

interface HighlightLayerProps {
  /** All annotations of the open PDF, driven by the annotations store. */
  annotations: readonly AnnotationItem[]
  /** `create` arms the drag-to-draw interaction on every page. */
  mode: AnnotationTool
  /** Color applied to newly created annotations. */
  color: string
  /** Id of the annotation the list/toolbar has selected; drawn emphasized. */
  selectedId: string | null
  /** Called when a rendered annotation rect is clicked. */
  onSelect: (id: string) => void
  /** Called with a completed normalized rect in drag-create mode. */
  onAdd: (pageIndex: number, rect: NormalizedRect) => void
  /** The context menu's "copy text" action, wired by the panel. */
  onCopyText: (item: AnnotationItem) => void
  /** The context menu's "copy reference" action, wired by the panel. */
  onCopyReference: (item: AnnotationItem) => void
  /** The context menu's "delete" action, wired by the panel. */
  onRemove: (id: string) => void
}

/** The props shape drag handlers and observers need to read live. */
type LatestProps = HighlightLayerProps & {
  /** Right-click on a rect: select it and open the menu at the cursor. */
  onRectContextMenu: (item: AnnotationItem, event: MouseEvent) => void
}

/**
 * The self-drawn annotation overlay for the pdf.js viewer. pdf.js's
 * AnnotationEditorLayer is deliberately not used — the sidecar's rects don't
 * map onto its editor model and its persistence is not ours — so this mounts a
 * per-page overlay (`position:absolute` inside each `.page`, above the canvas
 * and text layer) and renders one positioned element per annotation.
 *
 * Layout is percentage-based, so zoom never needs re-measurement: a normalized
 * rect maps to `left/top/width/height` as percentages of the page element,
 * which pdf.js resizes (via `--scale-factor`) to match the rendered canvas.
 * Pages are transient in pdf.js (buffer eviction wipes and re-renders their
 * children), so a MutationObserver on the viewer re-syncs the overlays
 * whenever page content changes; mutations inside an overlay are ignored.
 */
export function HighlightLayer(props: HighlightLayerProps): ReactElement | null {
  const { viewer } = usePdfViewer()
  // 右键标注矩形 = 选中 + 在光标处打开上下文菜单；矩形是手动 DOM，处理函数
  // 通过 latest 读取最新实现。
  const [menu, setMenu] = useState<AnnotationMenuAnchor | null>(null)
  const handleRectContextMenu = useCallback(
    (item: AnnotationItem, event: MouseEvent): void => {
      props.onSelect(item.id)
      setMenu({ x: event.clientX, y: event.clientY, item })
    },
    [props.onSelect],
  )
  // Drag handlers and the observer run outside React's render; they read the
  // freshest props through this ref instead of closing over a stale render.
  const latest = useRef<LatestProps>({ ...props, onRectContextMenu: handleRectContextMenu })
  useEffect(() => {
    latest.current = { ...props, onRectContextMenu: handleRectContextMenu }
  })

  useEffect(() => {
    if (viewer === null || viewer.viewer === null) {
      return
    }
    syncOverlays(viewer, latest)
  }, [viewer, props.annotations, props.mode, props.color, props.selectedId])

  useEffect(() => {
    if (viewer === null || viewer.viewer === null) {
      return
    }
    let frame: number | null = null
    const schedule = (): void => {
      if (frame !== null) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = null
        if (viewer.viewer !== null) {
          syncOverlays(viewer, latest)
        }
      })
    }
    const observer = new MutationObserver((mutations) => {
      // Overlay-internal edits (rect rebuilds, the drag preview) would loop
      // otherwise; only page-level DOM changes need a re-sync.
      const touchesPages = mutations.some((mutation) => {
        const target = mutation.target as HTMLElement
        return target.closest(`.${OVERLAY_CLASS}`) === null
      })
      if (touchesPages) {
        schedule()
      }
    })
    observer.observe(viewer.viewer, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [viewer])

  return (
    <AnnotationContextMenu
      anchor={menu}
      onClose={() => setMenu(null)}
      onCopyText={props.onCopyText}
      onCopyReference={props.onCopyReference}
      onRemove={props.onRemove}
    />
  )
}

function syncOverlays(
  viewer: import('pdfjs-dist/legacy/web/pdf_viewer.mjs').PDFViewer,
  latest: MutableRefObject<LatestProps>,
): void {
  const view = viewer.viewer
  if (view === null) {
    return
  }
  const props = latest.current
  const annotationsByPage = new Map<number, readonly AnnotationItem[]>()
  for (const annotation of props.annotations) {
    const existing = annotationsByPage.get(annotation.pageIndex)
    annotationsByPage.set(
      annotation.pageIndex,
      existing === undefined ? [annotation] : [...existing, annotation],
    )
  }
  for (const pageElement of view.querySelectorAll<HTMLElement>(`.page`)) {
    const pageNumber = Number(pageElement.getAttribute('data-page-number'))
    if (Number.isNaN(pageNumber)) {
      continue
    }
    const pageIndex = pageNumber - 1
    const items = annotationsByPage.get(pageIndex) ?? []
    const wrapper = ensureWrapper(pageElement, pageNumber, latest)
    if (wrapper === null) {
      continue
    }
    wrapper.style.pointerEvents = props.mode === 'create' ? 'auto' : 'none'
    wrapper.style.cursor = props.mode === 'create' ? 'crosshair' : ''
    wrapper.replaceChildren(...items.map((item) => createRectElement(item, props, latest)))
  }
}

/** Find or create the overlay wrapper for one page, wiring drag-creation. */
function ensureWrapper(
  pageElement: HTMLElement,
  pageNumber: number,
  latest: MutableRefObject<LatestProps>,
): HTMLElement | null {
  let wrapper = pageElement.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`)
  if (wrapper !== null) {
    return wrapper
  }
  if (pageNumber <= 0) {
    return null
  }
  wrapper = document.createElement('div')
  wrapper.className = OVERLAY_CLASS
  wrapper.dataset.pageNumber = String(pageNumber)
  wrapper.style.cssText =
    'position:absolute; inset:0; z-index:2; pointer-events:none; touch-action:none;'
  // Drag-creation lives on the wrapper so a page with no annotations can still
  // receive draws; the handler reads the live mode through the latest ref.
  wrapper.addEventListener('pointerdown', (event) => startDrag(wrapper!, pageNumber, event, latest))
  pageElement.append(wrapper)
  return wrapper
}

function startDrag(
  wrapper: HTMLElement,
  pageNumber: number,
  event: PointerEvent,
  latest: MutableRefObject<LatestProps>,
): void {
  if (event.button !== 0) {
    return
  }
  const bounds = wrapper.getBoundingClientRect()
  const start: Point = {
    x: clamp01((event.clientX - bounds.left) / bounds.width),
    y: clamp01((event.clientY - bounds.top) / bounds.height),
  }
  let end: Point = start
  event.preventDefault()

  const preview = document.createElement('div')
  preview.style.cssText =
    'position:absolute; z-index:3; pointer-events:none; ' +
    'border:1.5px dashed rgb(120 120 120); background:rgb(0 0 0 / 0.06);'
  wrapper.append(preview)

  const onMove = (moveEvent: PointerEvent): void => {
    const currentBounds = wrapper.getBoundingClientRect()
    end = {
      x: clamp01((moveEvent.clientX - currentBounds.left) / currentBounds.width),
      y: clamp01((moveEvent.clientY - currentBounds.top) / currentBounds.height),
    }
    const [left, top, right, bottom] = normalizedRectFromPoints(start, end)
    preview.style.left = percent(left)
    preview.style.top = percent(top)
    preview.style.width = percent(right - left)
    preview.style.height = percent(bottom - top)
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    preview.remove()
    const [left, top, right, bottom] = normalizedRectFromPoints(start, end)
    if (right - left < MIN_NORMALIZED_SIZE || bottom - top < MIN_NORMALIZED_SIZE) {
      return
    }
    latest.current.onAdd(pageNumber - 1, [left, top, right, bottom])
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function createRectElement(
  item: AnnotationItem,
  props: LatestProps,
  latest: MutableRefObject<LatestProps>,
): HTMLElement {
  // Empty-rect annotations (malformed sidecars) get a zero-size element rather
  // than a crash: `rects[0]` can be absent under the store's loose schema.
  const [left, top, right, bottom] = rectTuple(item.rects[0])
  const element = document.createElement('div')
  element.className = RECT_CLASS
  element.dataset.annotationId = item.id
  const fill = item.type === 'text' ? withAlpha(item.color, 0.3) : 'transparent'
  const borderWidth = item.type === 'text' ? '1px' : '2px'
  element.style.cssText =
    `position:absolute; ` +
    `left:${percent(left)}; top:${percent(top)}; ` +
    `width:${percent(right - left)}; height:${percent(bottom - top)}; ` +
    `background:${fill}; border:${borderWidth} solid ${item.color}; ` +
    `border-radius:2px; box-sizing:border-box; pointer-events:auto; cursor:pointer;`
  if (props.mode === 'create') {
    element.style.pointerEvents = 'none'
  }
  if (item.text !== '') {
    element.title = item.text
  }
  element.addEventListener('mouseenter', () => {
    element.style.filter = 'brightness(0.85)'
    element.style.outline = `2px solid ${item.color}`
  })
  element.addEventListener('mouseleave', () => {
    element.style.filter = ''
    element.style.outline = ''
  })
  if (props.selectedId === item.id) {
    element.style.outline = `2px solid ${item.color}`
    element.style.boxShadow = '0 0 0 1px rgb(255 255 255 / 0.9), 0 0 0 3px rgb(0 0 0 / 0.35)'
  }
  element.addEventListener('click', () => {
    latest.current.onSelect(item.id)
  })
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    latest.current.onRectContextMenu(item, event)
  })
  return element
}

/** `#rrggbb` + alpha → 8-digit hex, matching how highlights render on light pages. */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (match === null) {
    return hex
  }
  const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
  return `#${match[1]}${value}`
}
