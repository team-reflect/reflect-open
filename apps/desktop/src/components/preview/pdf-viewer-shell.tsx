import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { ChevronLeft, ChevronRight, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
import { errorMessage, readAssetBinary } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

// The worker ships from `apps/desktop/public/pdf.worker.min.mjs` (a copy of the
// pdfjs-dist legacy worker), so it loads same-origin under the app's CSP
// (`script-src 'self'`, no `worker-src`). pdf.js chooses an ES-module worker
// when the URL ends in `.mjs`.
GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

/** The zoom step applied by the in/out buttons. */
const ZOOM_STEP = 1.2
/** Hard zoom bounds, mirroring the full viewer's practical range. */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5

interface PdfViewerContextValue {
  /** The live PDFViewer once a document has been loaded; null before/after. */
  viewer: PDFViewer | null
  /** True once `pagesinit` has fired and the viewer is usable. */
  ready: boolean
  /** 1-based page currently shown. */
  currentPage: number
  /** The most recent load failure, or null while healthy. */
  error: string | null
}

const PdfViewerContext = createContext<PdfViewerContextValue | null>(null)

/** Read the PDFViewer instance + document state owned by {@link PdfViewerShell}. */
export function usePdfViewer(): PdfViewerContextValue {
  const value = use(PdfViewerContext)
  if (value === null) {
    throw new Error('usePdfViewer must be used within a PdfViewerShell')
  }
  return value
}

interface PdfViewerShellProps {
  /** Graph-relative path of the PDF asset to display. */
  assetPath: string
  /** 1-based page to jump to once the document is ready. */
  initialPage?: number
  /** Rendered under the provider (consumes `usePdfViewer`), not in the chrome. */
  children?: ReactNode
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, page), pageCount)
}

/**
 * Owns the pdf.js lifecycle for one PDF: reads the bytes via
 * `readAssetBinary`, feeds them to `getDocument` (never a URL, so the CSP's
 * `connect-src` is untouched), mounts a `PDFViewer`, and renders the page/zoom
 * chrome above it. `isEvalSupported: false` keeps the worker off `new
 * Function`, which `script-src 'self'` would otherwise block on WKWebView.
 *
 * A fresh PDFViewer + EventBus is created per document load; every listener and
 * the viewer's scroll/resize observers are torn down through the load's
 * AbortController, and `pdfDocument.destroy()` releases the worker side. The
 * parent must key this component by `assetPath` to avoid reusing a document
 * across different PDFs.
 */
export function PdfViewerShell({
  assetPath,
  initialPage,
  children,
}: PdfViewerShellProps): ReactElement {
  const { graph } = useGraph()
  const generation = graph?.generation

  const containerRef = useRef<HTMLDivElement>(null)
  const viewerElementRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PDFViewer | null>(null)
  const initialPageRef = useRef<number | undefined>(initialPage)

  const [ready, setReady] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    initialPageRef.current = initialPage
  }, [initialPage])

  useEffect(() => {
    const container = containerRef.current
    const viewerElement = viewerElementRef.current
    if (container === null || viewerElement === null || generation === undefined) {
      return
    }

    const controller = new AbortController()
    const eventBus = new EventBus()
    let pdfViewer: PDFViewer | null = null
    let loadingTask: PDFDocumentLoadingTask | null = null
    let pdfDocument: PDFDocumentProxy | null = null

    setError(null)
    setReady(false)

    const onPagesInit = (): void => {
      if (pdfViewer === null) {
        return
      }
      // First paint fits the page width; the toolbar offers explicit zoom on top.
      if (pdfViewer.currentScaleValue === null) {
        pdfViewer.currentScaleValue = 'page-width'
      }
      setZoomPercent(Math.round(pdfViewer.currentScale * 100))
      setCurrentPage(pdfViewer.currentPageNumber)
      const page = initialPageRef.current
      if (page !== undefined && page >= 1) {
        pdfViewer.currentPageNumber = clampPage(page, pdfViewer.pagesCount)
      }
      setReady(true)
    }
    eventBus.on('pagesinit', onPagesInit)
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      setCurrentPage(pageNumber)
    })
    eventBus.on('scalechanging', () => {
      if (pdfViewer !== null) {
        setZoomPercent(Math.round(pdfViewer.currentScale * 100))
      }
    })

    void (async () => {
      try {
        const data = await readAssetBinary(assetPath, generation)
        if (controller.signal.aborted) {
          return
        }
        loadingTask = getDocument({ data, isEvalSupported: false })
        pdfDocument = await loadingTask.promise
        if (controller.signal.aborted) {
          void pdfDocument.destroy()
          return
        }
        pdfViewer = new PDFViewer({
          container,
          viewer: viewerElement,
          eventBus,
          // No pinch-gesture wrapper: zoom is toolbar-only.
          supportsPinchToZoom: false,
        })
        viewerRef.current = pdfViewer
        pdfViewer.setDocument(pdfDocument)
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause))
        }
      }
    })()

    return () => {
      controller.abort()
      viewerRef.current = null
      // `viewer.setDocument(null)` resets page views without touching the
      // container; destroy releases worker-side state. The d.ts only admits a
      // document, but null is the runtime's documented reset.
      pdfViewer?.setDocument(null as unknown as PDFDocumentProxy)
      void loadingTask?.destroy().catch(() => {})
      void pdfDocument?.destroy().catch(() => {})
    }
  }, [assetPath, generation])

  // The initial page prop can change without a reload once the doc is ready.
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer !== null && ready && initialPage !== undefined && initialPage >= 1) {
      viewer.currentPageNumber = clampPage(initialPage, viewer.pagesCount)
    }
  }, [initialPage, ready])

  const pageCount = viewerRef.current?.pagesCount ?? 0
  const goToPage = (page: number): void => {
    const viewer = viewerRef.current
    if (viewer === null || viewer.pagesCount === 0) {
      return
    }
    viewer.currentPageNumber = clampPage(page, viewer.pagesCount)
  }
  const zoomBy = (factor: number): void => {
    const viewer = viewerRef.current
    if (viewer === null) {
      return
    }
    const next = viewer.currentScale * factor
    viewer.currentScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
  }

  return (
    <PdfViewerContext value={{ viewer: viewerRef.current, ready, currentPage, error }}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
          <PageChrome
            ready={ready}
            pageCount={pageCount}
            currentPage={currentPage}
            onGoToPage={goToPage}
            onZoomIn={() => zoomBy(ZOOM_STEP)}
            onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
            onFitWidth={() => {
              const viewer = viewerRef.current
              if (viewer !== null) {
                viewer.currentScaleValue = 'page-width'
              }
            }}
            zoomPercent={zoomPercent}
          />
        </div>
        <div className="relative min-h-0 flex-1 bg-surface-sunken">
          {error !== null ? (
            <div className="p-3 text-xs text-destructive" role="alert">
              {error}
            </div>
          ) : (
            <div ref={containerRef} className="absolute inset-0 overflow-auto">
              <div ref={viewerElementRef} className="pdfViewer" />
            </div>
          )}
        </div>
        {children}
      </div>
    </PdfViewerContext>
  )
}

interface PageChromeProps {
  ready: boolean
  pageCount: number
  currentPage: number
  zoomPercent: number
  onGoToPage: (page: number) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFitWidth: () => void
}

function PageChrome({
  ready,
  pageCount,
  currentPage,
  zoomPercent,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onFitWidth,
}: PageChromeProps): ReactElement {
  const [draft, setDraft] = useState(String(currentPage))
  // Re-sync the draft when the viewer's page changes without typing (buttons,
  // scroll, a jump from the annotation list). Settled during render, not in an
  // effect, so the rule against setState-in-effect stays quiet.
  const [lastPage, setLastPage] = useState(currentPage)
  if (lastPage !== currentPage) {
    setLastPage(currentPage)
    setDraft(String(currentPage))
  }

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (Number.isNaN(parsed)) {
      setDraft(String(currentPage))
      return
    }
    onGoToPage(parsed)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous page"
        disabled={!ready || currentPage <= 1}
        onClick={() => onGoToPage(currentPage - 1)}
      >
        <ChevronLeft />
      </Button>
      <input
        className={cn(
          'h-6 w-9 rounded border border-border bg-surface text-center text-xs tabular-nums outline-none',
          'focus:border-ring focus:ring-2 focus:ring-ring/50',
        )}
        value={draft}
        disabled={!ready}
        aria-label="Current page"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
        }}
      />
      <span className="text-xs text-text-muted">/ {pageCount}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next page"
        disabled={!ready || currentPage >= pageCount}
        onClick={() => onGoToPage(currentPage + 1)}
      >
        <ChevronRight />
      </Button>
      <span className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        disabled={!ready}
        onClick={onZoomOut}
      >
        <ZoomOut />
      </Button>
      <span className="w-11 text-center text-xs tabular-nums text-text-muted">{zoomPercent}%</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        disabled={!ready}
        onClick={onZoomIn}
      >
        <ZoomIn />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Fit width"
        title="Fit width"
        disabled={!ready}
        onClick={onFitWidth}
      >
        <Maximize2 />
      </Button>
    </>
  )
}
