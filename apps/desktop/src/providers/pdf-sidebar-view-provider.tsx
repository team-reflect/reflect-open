import {
  createContext,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/** The sidebar stack's current top: the document panel (default) or the PDF panel. */
export type PdfSidebarView = 'document' | 'pdf'

interface PdfSidebarViewContextValue {
  view: PdfSidebarView
  /** Push the PDF panel on top (the document panel's "enter PDF panel" entry). */
  enterPdf: () => void
  /** Pop back to the document panel (the PDF panel's "back to document" button). */
  backToDocument: () => void
  /**
   * Called as the preview target's pdf-ness changes. Only edge transitions
   * (false→true or true→false) switch the view automatically; a steady state
   * is a no-op — after the user manually returns to the document panel while
   * the PDF stays open, re-renders must not push them back.
   */
  applyTarget: (isPdf: boolean) => void
}

const PdfSidebarViewContext = createContext<PdfSidebarViewContextValue>({
  view: 'document',
  enterPdf: () => {},
  backToDocument: () => {},
  applyTarget: () => {},
})

/**
 * The sidebar's "stack": the document panel (Note actions, Similar notes, …)
 * sits on the bottom; opening a PDF pushes the PDF panel on top, and closing
 * it pops back. View transitions are user actions (`enterPdf` /
 * `backToDocument`) or edge-triggered by the preview target changing — a
 * steady state never overrides a manual choice.
 */
export function PdfSidebarViewProvider({ children }: { children: ReactNode }): ReactElement {
  const [view, setView] = useState<PdfSidebarView>('document')
  // The pdf-ness of the last applyTarget call: only an edge transition auto-
  // switches, so a re-render never overrides the user's chosen view.
  const isPdfRef = useRef<boolean | null>(null)

  const applyTarget = useCallback((isPdf: boolean): void => {
    const previous = isPdfRef.current
    isPdfRef.current = isPdf
    if (previous === isPdf) {
      return
    }
    setView(isPdf ? 'pdf' : 'document')
  }, [])

  const enterPdf = useCallback(() => {
    setView('pdf')
  }, [])
  const backToDocument = useCallback(() => {
    setView('document')
  }, [])
  const value = useMemo(
    () => ({ view, enterPdf, backToDocument, applyTarget }),
    [view, enterPdf, backToDocument, applyTarget],
  )
  return <PdfSidebarViewContext value={value}>{children}</PdfSidebarViewContext>
}

/** The sidebar stack's current top, plus the manual push/pop actions. */
export function usePdfSidebarView(): PdfSidebarViewContextValue {
  return use(PdfSidebarViewContext)
}
