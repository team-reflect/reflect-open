import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'

/**
 * The open PDF's live session: the panel's pdf.js viewer and document, shared
 * with the context sidebar so it can read the outline, render thumbnails, and
 * command page jumps. The sidebar is a separate component tree from the split
 * pane (one in AppShell's main column, one in its context aside), so the
 * document has to travel through context rather than props.
 *
 * The panel's {@link PdfViewerShell} registers the session once its document
 * finishes loading and clears it on unmount (panel closed, PDF switched, or
 * graph session changed); the sidebar block renders only while a matching
 * session exists. Nothing here owns the pdf.js lifecycle — the shell does —
 * this is just the mailbox.
 */

export interface PdfSession {
  /** The panel's PDFViewer, for jump commands. */
  viewer: PDFViewer | null
  /** The loaded PDFDocumentProxy, for outline and thumbnail reads. */
  pdfDocument: PDFDocumentProxy | null
  /** The graph-relative `assets/…pdf` path the session belongs to. */
  assetPath: string | null
}

const EMPTY_SESSION: PdfSession = { viewer: null, pdfDocument: null, assetPath: null }

interface PdfSessionContextValue {
  session: PdfSession
  /** Publish a loaded viewer/document pair; replaces any previous session. */
  register: (session: {
    viewer: PDFViewer
    pdfDocument: PDFDocumentProxy
    assetPath: string
  }) => void
  /** Drop the session (the publishing shell is tearing its document down). */
  clear: () => void
}

const PdfSessionContext = createContext<PdfSessionContextValue>({
  session: EMPTY_SESSION,
  register: () => {},
  clear: () => {},
})

/** Provides the PDF session to the preview pane and the context sidebar. */
export function PdfSessionProvider({ children }: { children: ReactNode }): ReactElement {
  const [session, setSession] = useState<PdfSession>(EMPTY_SESSION)
  const register = useCallback(
    (next: { viewer: PDFViewer; pdfDocument: PDFDocumentProxy; assetPath: string }): void => {
      setSession({ viewer: next.viewer, pdfDocument: next.pdfDocument, assetPath: next.assetPath })
    },
    [],
  )
  const clear = useCallback((): void => {
    setSession(EMPTY_SESSION)
  }, [])
  const value = useMemo(() => ({ session, register, clear }), [session, register, clear])
  return <PdfSessionContext value={value}>{children}</PdfSessionContext>
}

/** The current PDF session, or the empty one when no PDF is loaded. */
export function usePdfSession(): PdfSessionContextValue {
  return use(PdfSessionContext)
}
