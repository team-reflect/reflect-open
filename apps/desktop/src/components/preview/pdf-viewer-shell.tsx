import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  Maximize2,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import 'pdfjs-dist/legacy/web/pdf_viewer.css'
// Loaded right after pdf_viewer.css: corrects the content-box mismatch
// between preflight's border-box and the .page border.
import './pdf-viewer-overrides.css'
import { errorMessage, readAssetBinary } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { usePdfSession } from '@/providers/pdf-session-provider'

// The worker URL comes straight from the pdfjs-dist package via Vite's `?url`
// (dev-served / emitted as a hashed `.mjs` asset), so it loads same-origin
// under the app's CSP (`script-src 'self'`, no `worker-src`) without a
// vendored copy in the repo. The `.mjs` suffix makes pdf.js choose an
// ES-module worker.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** The zoom step applied by the in/out buttons. */
const ZOOM_STEP = 1.2
/** Hard zoom bounds, mirroring the full viewer's practical range. */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5

/** The scale presets the toolbar offers, as pdf.js `currentScaleValue` strings. */
export type PdfScalePreset = 'page-width' | 'page-fit' | 'page-actual'

/**
 * Whether a scale value is a fit preset: pdf.js re-derives the pixel scale
 * from the container's current size whenever one of these is assigned, so
 * re-assigning it on a container resize re-fits the pages.
 */
function isFitPreset(value: string): value is 'page-width' | 'page-fit' {
  return value === 'page-width' || value === 'page-fit'
}

interface PdfViewerContextValue {
  /** The live PDFViewer once a document has been loaded; null before/after. */
  viewer: PDFViewer | null
  /** True once `pagesinit` has fired and the viewer is usable. */
  ready: boolean
  /** 1-based page currently shown. */
  currentPage: number
  /** Total pages; 0 until the document loads. */
  pageCount: number
  /** The raw `currentScaleValue` string ('page-width', 'page-fit', or a percent). */
  scaleValue: string
  /** The rendered zoom as a whole percent. */
  zoomPercent: number
  /** The most recent load failure, or null while healthy. */
  error: string | null
  /** Jump to a 1-based page, clamped to the document. */
  goToPage: (page: number) => void
  /** Multiply the current zoom by `factor`, clamped to the hard bounds. */
  zoomBy: (factor: number) => void
  /** Apply a scale preset (fit width / fit page / actual size). */
  setScalePreset: (preset: PdfScalePreset) => void
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
  /** Closes the enclosing surface; the toolbar renders an explicit X. */
  onClose?: () => void
  /**
   * Publish the loaded viewer/document to the PDF session the context
   * sidebar's outline/thumbnail block consumes. Only the panel's shell sets
   * this — the fullscreen overlay's shell must not displace the session.
   */
  publishSession?: boolean
  /**
   * The toolbar to render above the pages. Defaults to the page chrome; the
   * fullscreen overlay passes its own (exit-only) chrome.
   */
  chrome?: ReactElement
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
 *
 * The document opens fitted to the panel's width, and the fit presets
 * (page-width / page-fit) re-fit whenever the panel is dragged wider or
 * narrower: pdf.js 4.x's own ResizeObserver only updates a container-height
 * CSS variable — it never recomputes the scale on a width change — so the
 * shell watches the container itself and re-applies the active preset.
 */
export function PdfViewerShell({
  assetPath,
  initialPage,
  onClose,
  publishSession = false,
  chrome,
  children,
}: PdfViewerShellProps): ReactElement {
  const { graph } = useGraph()
  const generation = graph?.generation
  const { register: registerSession, clear: clearSession } = usePdfSession()

  const containerRef = useRef<HTMLDivElement>(null)
  const viewerElementRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PDFViewer | null>(null)
  const initialPageRef = useRef<number | undefined>(initialPage)

  const [ready, setReady] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [scaleValue, setScaleValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)

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
      // Open fitted to the panel's width. pdf.js's default is 'auto', which
      // behaves like page-width for portrait pages — pin it explicitly so the
      // initial zoom always tracks the panel, and so scaleValue reads as the
      // active preset for the toolbar.
      pdfViewer.currentScaleValue = 'page-width'
      setScaleValue(pdfViewer.currentScaleValue)
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
        setScaleValue(pdfViewer.currentScaleValue)
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
          // Enable the text layer explicitly (TextLayerMode.ENABLE = 1; the
          // enum is not exported from the web build): text selection and the
          // annotation layer depend on it, so don't rely on the constructor default.
          textLayerMode: 1,
          // No pinch-gesture wrapper: zoom is toolbar-only.
          supportsPinchToZoom: false,
        })
        viewerRef.current = pdfViewer
        pdfViewer.setDocument(pdfDocument)
        // The sidebar's outline/thumbnail block consumes this document:
        // publish it once loaded, clear it on unmount.
        if (publishSession) {
          registerSession({ viewer: pdfViewer, pdfDocument, assetPath })
        }
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
      if (publishSession) {
        clearSession()
      }
    }
  }, [assetPath, generation, publishSession, registerSession, clearSession])

  // The initial page prop can change without a reload once the doc is ready.
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer !== null && ready && initialPage !== undefined && initialPage >= 1) {
      viewer.currentPageNumber = clampPage(initialPage, viewer.pagesCount)
    }
  }, [initialPage, ready])

  // Re-fit the pages while a fit preset is active and the panel is dragged
  // wider/narrower. pdf.js 4.x's internal ResizeObserver never recomputes an
  // 'auto'-style scale on a container width change, so the preset is re-applied
  // here — assigning a preset re-derives the pixel scale from the container's
  // fresh width. A numeric scale (an explicit zoom) is left alone.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) {
      return
    }
    const observer = new ResizeObserver(() => {
      const viewer = viewerRef.current
      if (viewer === null) {
        return
      }
      const value = viewer.currentScaleValue
      if (isFitPreset(value)) {
        viewer.currentScaleValue = value
      }
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [])

  // Escape exits the fullscreen overlay, the desktop viewer convention.
  useEffect(() => {
    if (!fullscreen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [fullscreen])

  const pageCount = viewerRef.current?.pagesCount ?? 0
  const goToPage = useCallback((page: number): void => {
    const viewer = viewerRef.current
    if (viewer === null || viewer.pagesCount === 0) {
      return
    }
    viewer.currentPageNumber = clampPage(page, viewer.pagesCount)
  }, [])
  const zoomBy = useCallback((factor: number): void => {
    const viewer = viewerRef.current
    if (viewer === null) {
      return
    }
    const next = viewer.currentScale * factor
    viewer.currentScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
  }, [])
  const setScalePreset = useCallback((preset: PdfScalePreset): void => {
    const viewer = viewerRef.current
    if (viewer === null) {
      return
    }
    viewer.currentScaleValue = preset
  }, [])

  return (
    <PdfViewerContext
      value={{
        viewer: viewerRef.current,
        ready,
        currentPage,
        pageCount,
        scaleValue,
        zoomPercent,
        error,
        goToPage,
        zoomBy,
        setScalePreset,
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* window-drag-control lifts the toolbar above the WindowDragRegion
            strip overlaying the title-bar band: the preview pane sits at the
            very top of the window, where the strip would otherwise swallow
            every click into a window drag. See NavigateArrows for the
            contract. */}
        <div className="window-drag-control flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
          {chrome ?? (
            <PageChrome
              onFullscreen={() => setFullscreen(true)}
              {...(onClose !== undefined ? { onClose } : {})}
            />
          )}
        </div>
        <div className="relative min-h-0 flex-1 bg-surface-sunken">
          {/* The container stays mounted on a load failure (the error overlays
              it) so the load effect's refs remain valid — otherwise a retry on
              the same instance (a graph-session bump) would bail on null refs
              and never load. */}
          <div ref={containerRef} className="absolute inset-0 overflow-auto">
            <div ref={viewerElementRef} className="pdfViewer" />
          </div>
          {error !== null ? (
            <div className="absolute inset-0 overflow-auto bg-surface-sunken p-3">
              <div className="p-3 text-xs text-destructive" role="alert">
                {error}
              </div>
            </div>
          ) : null}
        </div>
        {children}
      </div>
      {fullscreen ? (
        // The fullscreen overlay: WKWebView/WebView2 lack the HTML Fullscreen
        // API, so the shared shadcn Dialog (focus trap, aria-modal, Escape)
        // is styled into a full-window surface. A fresh PdfViewerShell is
        // mounted recursively (same assetPath, starting at the current page)
        // instead of re-homing the panel's pdf.js instance — the annotation
        // layers and containers are bound to the panel's DOM, and moving them
        // would misplace coordinates; the cost is one extra document render,
        // destroyed on exit.
        <Dialog
          open={fullscreen}
          onOpenChange={(next) => {
            if (!next) {
              setFullscreen(false)
            }
          }}
        >
          <DialogContent
            showCloseButton={false}
            aria-label="PDF fullscreen"
            overlayClassName="bg-surface"
            className="fixed inset-0 top-0 left-0 z-50 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-surface p-0 text-text ring-0 outline-none sm:max-w-none"
          >
            <PdfViewerShell
              assetPath={assetPath}
              initialPage={currentPage}
              chrome={<PageChrome fullscreen onClose={() => setFullscreen(false)} />}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </PdfViewerContext>
  )
}

interface PageChromeProps {
  /** Fullscreen overlay mode: no enter-fullscreen button; the trailing button exits. */
  fullscreen?: boolean
  /** The close/exit affordance rendered at the toolbar's trailing edge. */
  onClose?: () => void
  /** Enter fullscreen; only wired on the panel's toolbar. */
  onFullscreen?: () => void
}

function PageChrome({ fullscreen = false, onClose, onFullscreen }: PageChromeProps): ReactElement {
  const {
    ready,
    currentPage,
    pageCount,
    zoomPercent,
    scaleValue,
    goToPage,
    zoomBy,
    setScalePreset,
  } = usePdfViewer()
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
    goToPage(parsed)
  }

  const presetProps = (preset: PdfScalePreset, label: string, title: string) => ({
    variant: 'ghost' as const,
    size: 'icon-sm' as const,
    'aria-label': label,
    'aria-pressed': scaleValue === preset,
    title,
    disabled: !ready,
    className: cn(scaleValue === preset && 'bg-muted text-foreground'),
    onClick: () => setScalePreset(preset),
  })

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous page"
        disabled={!ready || currentPage <= 1}
        onClick={() => goToPage(currentPage - 1)}
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
        onClick={() => goToPage(currentPage + 1)}
      >
        <ChevronRight />
      </Button>
      <span className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        disabled={!ready}
        onClick={() => zoomBy(1 / ZOOM_STEP)}
      >
        <ZoomOut />
      </Button>
      <span
        aria-label="Zoom level"
        className="w-11 text-center text-xs tabular-nums text-text-muted"
      >
        {zoomPercent}%
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        disabled={!ready}
        onClick={() => zoomBy(ZOOM_STEP)}
      >
        <ZoomIn />
      </Button>
      <span className="mx-1 h-4 w-px bg-border" />
      <Button {...presetProps('page-width', 'Fit width', 'Fit width')}>
        <Maximize2 />
      </Button>
      <Button {...presetProps('page-fit', 'Fit page', 'Fit page')}>
        <Scan />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        aria-label="Actual size"
        aria-pressed={scaleValue === 'page-actual'}
        title="Actual size"
        disabled={!ready}
        className={cn(
          'px-1.5 tabular-nums',
          scaleValue === 'page-actual' && 'bg-muted text-foreground',
        )}
        onClick={() => setScalePreset('page-actual')}
      >
        100%
      </Button>
      {!fullscreen ? (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fullscreen"
            title="Fullscreen"
            disabled={!ready}
            onClick={onFullscreen}
          >
            <Maximize />
          </Button>
        </>
      ) : null}
      {onClose ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={fullscreen ? 'Exit fullscreen' : 'Close preview'}
          title={fullscreen ? 'Exit fullscreen' : 'Close preview'}
          className="ml-auto"
          onClick={onClose}
        >
          <X />
        </Button>
      ) : null}
    </>
  )
}
