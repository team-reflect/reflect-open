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

/** 侧栏堆栈的当前顶层：文档面板（默认）还是 PDF 面板。 */
export type PdfSidebarView = 'document' | 'pdf'

interface PdfSidebarViewContextValue {
  view: PdfSidebarView
  /** 手动切到 PDF 面板（文档面板里的「进入 PDF 面板」入口）。 */
  enterPdf: () => void
  /** 手动回到文档面板（PDF 面板里的「返回文档面板」按钮）。 */
  backToDocument: () => void
  /**
   * 随 preview target 的 pdf 状态变化调用。只在边缘变化（false→true 或
   * true→false）时自动切换视图；状态不变时是 no-op——用户在 PDF 仍打开时
   * 手动回到文档面板，之后的重渲染不会把他再推回 PDF 面板。
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
  // 最近一次 applyTarget 收到的 pdf 状态：边缘变化才自动切换，重渲染不覆盖
  // 用户手动选中的视图。
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
