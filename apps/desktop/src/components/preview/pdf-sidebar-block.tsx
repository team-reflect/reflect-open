import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import { SidebarSection } from '@/components/context-sidebar/sidebar-section'
import { usePdfSession } from '@/providers/pdf-session-provider'
import { usePdfSidebarView } from '@/providers/pdf-sidebar-view-provider'
import { cn } from '@/lib/utils'

/** The structural subset of a pdf.js outline node (`getOutline`'s return shape). */
interface PdfOutlineItem {
  title: string
  bold: boolean
  italic: boolean
  color: Uint8ClampedArray
  dest: string | unknown[] | null
  url: string | null
  items: PdfOutlineItem[]
}

/** The thumbnail's target CSS width, in pixels. */
const THUMBNAIL_WIDTH_PX = 96

/** The sidebar body-row typography, matching the Similar notes section and peers. */
const ROW_CLASS =
  'flex w-full items-center space-x-1 rounded-md px-3 py-1 leading-5 text-text-secondary ' +
  'transition-colors duration-100 hover:bg-surface-hover hover:text-text'

interface PdfSectionProps {
  /** The header title (same casing and spacing as the other sidebar sections). */
  title: string
  /** The per-open expand preset: Outline expanded, Pages collapsed. */
  defaultOpen: boolean
  children: ReactNode
}

/**
 * The PDF panel's collapsible section — the `SidebarSection` look and feel
 * (quiet sentence-case header, right chevron that only appears on hover while
 * open, `aria-expanded`), with two structural differences the PDF reading mode
 * needs: the open state is a per-open preset (`defaultOpen`), never persisted,
 * so every PDF opens with Outline expanded and Pages collapsed; and the
 * content area flexes to fill the panel's remaining height (`flex-1 min-h-0`,
 * the child scrolls internally) instead of growing with its content — so the
 * expanded section naturally takes the panel's ~80% and two expanded sections
 * split it. Each section is a single flex item stacked in order, header
 * `shrink-0`; no nested wrapper that could hide a sibling.
 */
function PdfSection({ title, defaultOpen, children }: PdfSectionProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen)

  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className={cn('flex min-h-0 flex-col', open && 'flex-1')}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="group flex w-full shrink-0 items-center px-3.5 text-2xs font-medium text-text-muted"
      >
        <span className="flex-1 truncate text-left">{title}</span>
        <span className={cn('flex-none group-hover:visible', open && 'invisible')}>
          <Chevron aria-hidden className="size-3" />
        </span>
      </button>
      {open ? <div className="min-h-0 flex-1 px-2">{children}</div> : null}
    </section>
  )
}

/** The extension-stripped filename of a graph-relative path, for the header. */
function pdfFilename(assetPath: string): string {
  return (
    assetPath
      .split('/')
      .pop()
      ?.replace(/\.pdf$/i, '') ?? assetPath
  )
}

/**
 * Resolve an outline destination (an explicit dest array or a named one) to a
 * 1-based page and jump the viewer there. Malformed destinations are a no-op —
 * an outline link that cannot resolve should not throw the sidebar.
 */
async function jumpToDestination(
  viewer: PDFViewer,
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<void> {
  let resolved: unknown = dest
  if (typeof resolved === 'string') {
    try {
      resolved = await doc.getDestination(resolved)
    } catch {
      return
    }
  }
  if (!Array.isArray(resolved) || resolved[0] === undefined) {
    return
  }
  try {
    const pageIndex = await doc.getPageIndex(resolved[0] as { num: number; gen: number })
    viewer.currentPageNumber = pageIndex + 1
  } catch {
    // A dest that cannot resolve (document destroyed, etc.): skip it.
  }
}

/**
 * The PDF panel on top of the sidebar stack while the user reads a PDF: the
 * filename header, a "PDF actions" section with the way back to the document
 * panel, the clickable outline, and one thumbnail per page. All three sections
 * are the same {@link SidebarSection} the document panel uses (sessionStorage
 * persistence, quiet headers), and the panel flows as plain block content —
 * no flex/scroll wrappers that could hide a section. The whole panel carries
 * the temporary `bg-accent/5` tint so it reads as a disposable surface next to
 * the permanent document context. Renders nothing until a session matching
 * `assetPath` exists, so a stale session never shows the previous PDF's
 * contents under a new filename.
 */
export function PdfSidebarBlock({ assetPath }: { assetPath: string }): ReactElement | null {
  const { session } = usePdfSession()
  const { backToDocument } = usePdfSidebarView()
  const { viewer, pdfDocument } = session
  if (pdfDocument === null || viewer === null || session.assetPath !== assetPath) {
    return null
  }

  return (
    // The panel fills the whole context sidebar (h-full); the filename header
    // and PDF actions stay fixed, while the Outline/Pages content areas each
    // take flex-1 in the column — with only Outline expanded (the default) it
    // fills the remaining space (~80% of the panel), two expanded sections
    // split it, and long content scrolls internally.
    <section
      aria-label={`PDF ${pdfFilename(assetPath)}`}
      className="flex h-full min-h-0 flex-col bg-accent/5"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2">
        <FileText aria-hidden className="size-4 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{pdfFilename(assetPath)}</div>
          <div className="truncate text-2xs text-text-muted">{assetPath}</div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pt-2 pb-3">
        <div className="shrink-0">
          <SidebarSection storageKey="pdf-actions" title="PDF actions">
            <button
              type="button"
              onClick={backToDocument}
              className={cn(ROW_CLASS, 'text-left text-xs font-medium')}
            >
              <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Back to document</span>
            </button>
          </SidebarSection>
        </div>
        <PdfOutline doc={pdfDocument} viewer={viewer} />
        <PdfThumbnails doc={pdfDocument} viewer={viewer} />
      </div>
    </section>
  )
}

/** The document's bookmark tree, loaded once per document and cancelled on change. */
function PdfOutline({
  doc,
  viewer,
}: {
  doc: PDFDocumentProxy
  viewer: PDFViewer
}): ReactElement | null {
  const [items, setItems] = useState<PdfOutlineItem[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // Outline reads are async setState (compliant); on a document switch the
    // whole panel usually remounts on a session mismatch, so the stale outline
    // lingers for at most a frame.
    void doc
      .getOutline()
      .then((outline) => {
        if (!cancelled) {
          setItems(outline ?? [])
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [doc])

  // While the outline loads, or the document has none, the section renders
  // nothing rather than flashing an empty placeholder.
  if (items === null || items.length === 0) {
    return null
  }

  return (
    <PdfSection title="Outline" defaultOpen>
      <div className="h-full min-h-0 overflow-y-auto">
        <OutlineList
          items={items}
          depth={0}
          onNavigate={(dest) => {
            void jumpToDestination(viewer, doc, dest)
          }}
        />
      </div>
    </PdfSection>
  )
}

function OutlineList({
  items,
  depth,
  onNavigate,
}: {
  items: readonly PdfOutlineItem[]
  depth: number
  onNavigate: (dest: string | unknown[] | null) => void
}): ReactElement {
  return (
    <ul className="space-y-0.5">
      {items.map((item, index) => (
        <li key={index}>
          <button
            type="button"
            disabled={item.dest === null}
            className={cn(
              ROW_CLASS,
              'disabled:cursor-default disabled:opacity-50',
              item.bold && 'font-semibold',
              item.italic && 'italic',
            )}
            style={{ paddingLeft: 12 + depth * 12 }}
            onClick={() => onNavigate(item.dest)}
          >
            <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
              {item.title}
            </span>
          </button>
          {item.items.length > 0 ? (
            <OutlineList items={item.items} depth={depth + 1} onNavigate={onNavigate} />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** One small canvas per page; rendering is cancelled when the panel unmounts. */
function PdfThumbnails({
  doc,
  viewer,
}: {
  doc: PDFDocumentProxy
  viewer: PDFViewer
}): ReactElement {
  const pages = Array.from({ length: doc.numPages }, (_, index) => index + 1)
  return (
    <PdfSection title="Pages" defaultOpen={false}>
      <div className="flex h-full min-h-0 flex-wrap gap-1.5 overflow-y-auto py-1">
        {pages.map((pageNumber) => (
          <PdfThumbnail
            key={pageNumber}
            doc={doc}
            pageNumber={pageNumber}
            onNavigate={(page) => {
              viewer.currentPageNumber = page
            }}
          />
        ))}
      </div>
    </PdfSection>
  )
}

function PdfThumbnail({
  doc,
  pageNumber,
  onNavigate,
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  onNavigate: (pageNumber: number) => void
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // One low-resolution render per page: pdf.js rasterizes on the worker
  // thread, the main thread only allocates the small canvases; in-flight
  // renders are cancelled and dropped on unmount / document switch.
  useEffect(() => {
    let cancelled = false
    let renderTask: RenderTask | null = null
    void (async () => {
      let page: PDFPageProxy
      try {
        page = await doc.getPage(pageNumber)
      } catch {
        return
      }
      if (cancelled) {
        return
      }
      const base = page.getViewport({ scale: 1 })
      const dpr = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: (THUMBNAIL_WIDTH_PX * dpr) / base.width })
      const canvas = canvasRef.current
      if (canvas === null) {
        return
      }
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (context === null) {
        return
      }
      renderTask = page.render({ canvasContext: context, viewport })
      try {
        await renderTask.promise
      } catch {
        // A cancelled render (unmount / document switch) is the expected path
      }
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNumber])

  return (
    <button
      type="button"
      aria-label={`Page ${pageNumber}`}
      title={`Page ${pageNumber}`}
      className="w-24 shrink-0 rounded border border-border bg-surface p-0.5 hover:border-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => onNavigate(pageNumber)}
    >
      <canvas ref={canvasRef} className="block w-full" />
    </button>
  )
}
