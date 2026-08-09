import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { errorMessage, isAppError, splitFrontmatter } from '@reflect/core'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { useOpenExternalLink } from '@/editor/open-external-link'
import { useAssetPersistence } from '@/editor/use-asset-persistence'
import { useBacklinkNavigation } from '@/hooks/use-backlink-navigation'
import { annotationReference } from '@/lib/annotations/annotation-reference'
import { parsePdfHref } from '@/lib/annotations/pdf-href'
import { extractRegionText } from '@/lib/annotations/pdf-region-text'
import type { PdfTextItemLike } from '@/lib/annotations/pdf-region-text'
import { normalizedSelectionRects, selectionToHighlight } from '@/lib/annotations/pdf-selection'
import { usePdfAnnotations, type AnnotationItem } from '@/lib/annotations/annotations-store'
import { startOperation } from '@/lib/operations'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { readExistingNoteSource } from '@/lib/read-existing-note-source'
import { useGraph } from '@/providers/graph-provider'
import { usePdfSession } from '@/providers/pdf-session-provider'
import {
  useSetPreviewPanelTarget,
  type PreviewPanelTarget,
} from '@/providers/preview-panel-provider'
import { AnnotationSection } from './annotation-section'
import {
  DEFAULT_ANNOTATION_COLOR,
  type AnnotationColor,
  type AnnotationTool,
} from './annotation-toolbar'
import { HighlightLayer, type NormalizedRect } from './highlight-layer'
import { PdfViewerShell } from './pdf-viewer-shell'

/**
 * The resident preview panel's content, opened for a PDF or note link and
 * rendered in the workspace's split pane — the vertical panel right of the
 * note pane, not the context aside (which keeps its daily/note context). Owns
 * the annotation interactions for PDF targets — the tool state (browse/draw,
 * the picker color, the selected annotation), which the toolbar, list, and
 * highlight layer all consume — and renders the note body read-only for note
 * targets. Navigation closes the panel (PreviewPanelProvider), so clicking a
 * wiki link in the note preview here just navigates the graph like anywhere
 * else.
 */

interface PdfPreviewProps {
  /** The PDF target to display, including the 1-based page it opened on. */
  target: Extract<PreviewPanelTarget, { kind: 'pdf' }>
  onClose: () => void
}

/**
 * Whether the event target is an editable region (input/textarea/select/rich
 * text) — the mode shortcuts must never fire on these, so page-number entry
 * and note editing are never interrupted. `[contenteditable]` excludes
 * `contenteditable="false"` (read-only fragments inside an editable host).
 */
function isEditableTarget(target: HTMLElement): boolean {
  return (
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
    null
  )
}

/** Give focus back to the reader after a mode shortcut (non-editable targets only). */
function blurActiveElement(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && !isEditableTarget(active)) {
    active.blur()
  }
}

/** The pdf.js `.page` element a selection range sits in, or null when outside one. */
function findSelectionPage(range: Range): HTMLElement | null {
  const container = range.commonAncestorContainer
  const element = container instanceof Element ? container : container.parentElement
  return element?.closest('.page') ?? null
}

/** The PDF branch: viewer + annotation overlay under one toolbar and list. */
function PdfPreview({ target, onClose }: PdfPreviewProps): ReactElement {
  const { graph } = useGraph()
  const generation = graph?.generation ?? null
  const { session } = usePdfSession()
  const { annotations, addAnnotation, removeAnnotation } = usePdfAnnotations(
    target.assetPath,
    generation,
  )
  const [mode, setMode] = useState<AnnotationTool>('browse')
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_ANNOTATION_COLOR)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Single-letter mode shortcuts and the ESC exit: `v` = Browse, `r` = Draw
  // Rectangle, `t` = Highlight text, ESC returns to Browse from any non-browse
  // mode. Scoped to the panel's lifetime (the listeners mount/unmount with
  // it); modifier keys (⌘/Ctrl/Alt, so ⌘V and friends pass through) and
  // editable targets (input/textarea/select/contenteditable — the page-number
  // field, the note editor) are skipped so typing is never interrupted. After
  // a handled shortcut the focused element is blurred (a toolbar button's
  // focus ring disappears) and focus returns to the reader.
  //
  // The mouseup listener runs the text-highlight capture: while the highlight
  // mode is active, releasing a text selection inside a pdf `.page` converts
  // it into a text-type annotation. The selection must sit inside a page
  // (found via the range's common ancestor) — a selection in the note editor
  // or elsewhere is left alone. Touch selection handles are out of scope.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
        return
      }
      const target = event.target
      if (target instanceof HTMLElement && isEditableTarget(target)) {
        return
      }
      if (event.key === 'Escape') {
        if (mode !== 'browse') {
          setMode('browse')
          blurActiveElement()
        }
        return
      }
      let next: AnnotationTool | null = null
      switch (event.key.toLowerCase()) {
        case 'v':
          next = 'browse'
          break
        case 'r':
          next = 'create'
          break
        case 't':
          next = 'highlight'
          break
      }
      if (next !== null) {
        setMode(next)
        blurActiveElement()
      }
    }
    const onMouseUp = (): void => {
      if (mode !== 'highlight') {
        return
      }
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        return
      }
      const range = selection.getRangeAt(0)
      const page = findSelectionPage(range)
      if (page === null) {
        return
      }
      const pageRect = page.getBoundingClientRect()
      if (pageRect.right <= pageRect.left || pageRect.bottom <= pageRect.top) {
        return
      }
      const pageNumber = Number(page.getAttribute('data-page-number'))
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        return
      }
      // The browser's selection rects can drift from the canvas glyphs when
      // pdf.js substitutes a font, so they only hit-test; the annotation rects
      // come from pdf.js's own text coordinates in createTextHighlight.
      const selectionRects = normalizedSelectionRects(range.getClientRects(), pageRect)
      if (selectionRects.length === 0) {
        return
      }
      void createTextHighlight(pageNumber - 1, selectionRects, selection)
    }
    const createTextHighlight = async (
      pageIndex: number,
      selectionRects: readonly NormalizedRect[],
      selection: Selection,
    ): Promise<void> => {
      const doc = session.pdfDocument
      if (doc === null) {
        return
      }
      try {
        const page = await doc.getPage(pageIndex + 1)
        const content = await page.getTextContent()
        const viewport = page.getViewport({ scale: 1 })
        const textItems = content.items.filter((textItem) => 'str' in textItem) as PdfTextItemLike[]
        const highlight = selectionToHighlight(selectionRects, textItems, viewport, pageIndex)
        if (highlight === null) {
          return
        }
        addAnnotation({ ...highlight, type: 'text', color })
        // Clear the selection so a second capture in a row starts fresh.
        selection.removeAllRanges()
      } catch {
        // A failed read (document destroyed mid-selection, etc.) drops the
        // capture rather than surfacing an error for a selection gesture.
      }
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [mode, color, addAnnotation])

  const handleAdd = useCallback(
    (pageIndex: number, rect: NormalizedRect): void => {
      addAnnotation({ pageIndex, type: 'border', rects: [rect], color, text: '' })
    },
    [addAnnotation, color],
  )

  const handleDeleteSelected = useCallback((): void => {
    if (selectedId !== null) {
      removeAnnotation(selectedId)
    }
    setSelectedId(null)
  }, [removeAnnotation, selectedId])

  // The context menu's actions: copy the annotation's text or a markdown
  // reference back to its page, and delete it. Copies land on the clipboard
  // and confirm through the operations status line, like the app's other copy
  // surfaces. An empty-text border annotation has its text extracted from the
  // PDF region the rect covers (via the shared session's document); nothing to
  // copy surfaces as a status-line warning instead.
  const handleCopyText = useCallback(
    (item: AnnotationItem): void => {
      const copy = (text: string): Promise<void> =>
        navigator.clipboard.writeText(text).then(() => {
          startOperation('Annotation text copied').done()
        })
      if (item.text.trim() !== '') {
        copy(item.text).catch((cause: unknown) => {
          startOperation('Copying annotation text').fail(errorMessage(cause))
        })
        return
      }
      const doc = session.pdfDocument
      if (item.type === 'border' && doc !== null) {
        void extractRegionText(doc, item)
          .then((text) => {
            if (text !== null) {
              return copy(text)
            }
            startOperation('Copying annotation text').warn('No text in this area')
          })
          .catch((cause: unknown) => {
            startOperation('Copying annotation text').fail(errorMessage(cause))
          })
        return
      }
      // No text to copy and nothing to extract from (a text-type annotation,
      // or the document is not ready).
      startOperation('Copying annotation text').warn('No text in this area')
    },
    [session.pdfDocument],
  )
  const handleCopyReference = useCallback(
    (item: AnnotationItem): void => {
      void navigator.clipboard
        .writeText(annotationReference(target.assetPath, item))
        .then(() => startOperation('Annotation reference copied').done())
        .catch((cause: unknown) => {
          startOperation('Copying annotation reference').fail(errorMessage(cause))
        })
    },
    [target.assetPath],
  )
  const handleRemove = useCallback(
    (id: string): void => {
      removeAnnotation(id)
      setSelectedId((current) => (current === id ? null : current))
    },
    [removeAnnotation],
  )

  return (
    <div className="flex h-full min-h-0 flex-col text-text">
      <PdfViewerShell
        assetPath={target.assetPath}
        {...(target.page !== undefined ? { initialPage: target.page } : {})}
        onClose={onClose}
        publishSession
      >
        <HighlightLayer
          annotations={annotations}
          mode={mode}
          color={color}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAdd}
          onCopyText={handleCopyText}
          onCopyReference={handleCopyReference}
          onRemove={handleRemove}
        />
        <AnnotationSection
          annotations={annotations}
          mode={mode}
          onModeChange={setMode}
          color={color}
          onColorChange={setColor}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDeleteSelected={handleDeleteSelected}
        />
      </PdfViewerShell>
    </div>
  )
}

interface NotePreviewProps {
  /** The note target's graph-relative path. */
  path: string
  onClose: () => void
}

/** Read the note body; a missing note is not an error here, it previews as empty. */
async function readNoteBody(path: string, generation: number): Promise<string | null> {
  try {
    return await readExistingNoteSource(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return null
    }
    throw cause
  }
}

/** The note branch: title header, live body preview, and a close button. */
function NotePreview({ path, onClose }: NotePreviewProps): ReactElement {
  const { graph } = useGraph()
  const generation = graph?.generation ?? null
  const { resolveImageUrl } = useAssetPersistence(generation)
  const { onWikilinkClick } = useBacklinkNavigation()
  const setPreviewPanelTarget = useSetPreviewPanelTarget()
  const openExternalLink = useOpenExternalLink()
  const { data, isError } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'preview-note', path],
    queryFn: () => {
      if (generation === null) {
        return null
      }
      return readNoteBody(path, generation)
    },
    enabled: generation !== null,
  })

  // PDF links inside the note body open the in-app PDF preview panel (the
  // annotation lane's migration links); every other link keeps the default
  // OS-opener behavior.
  const onLinkClick = useCallback(
    (href: string, event: MouseEvent | KeyboardEvent): void => {
      const pdfHref = parsePdfHref(href)
      if (pdfHref !== null) {
        event.preventDefault()
        setPreviewPanelTarget({
          kind: 'pdf',
          assetPath: pdfHref.path,
          ...(pdfHref.page !== undefined ? { page: pdfHref.page } : {}),
        })
        return
      }
      openExternalLink({ href, event })
    },
    [openExternalLink, setPreviewPanelTarget],
  )

  const body = data === null || data === undefined ? null : splitFrontmatter(data).body
  const title = path.split('/').pop()?.replace(/\.md$/i, '') ?? path

  let content: ReactElement
  if (isError) {
    content = <p className="px-3.5 py-3 text-sm text-text-muted">This note can’t be previewed.</p>
  } else if (body === null || body.trim() === '') {
    content = <p className="px-3.5 py-3 text-sm text-text-muted italic">Empty</p>
  } else {
    content = (
      <MarkdownPreview
        content={body}
        resolveImageUrl={resolveImageUrl}
        onLinkClick={onLinkClick}
        onWikiLinkClick={(target, event) => {
          if (event !== undefined) {
            onWikilinkClick({ target, event })
          }
        }}
        interactive
        className="px-3.5 py-2 text-sm"
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-text">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{title}</div>
          <div className="truncate text-2xs text-text-muted">{path}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close preview"
          title="Close preview"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
    </div>
  )
}

interface PreviewPanelProps {
  /** The open preview panel's target; never null here (the shell hides the pane). */
  target: PreviewPanelTarget
  onClose: () => void
}

/**
 * Renders the resident preview panel for its target. Keyed on the target's
 * subject so switching PDFs (or notes) remounts the branch and resets its
 * interaction state instead of leaking the previous document's selection.
 */
export function PreviewPanel({ target, onClose }: PreviewPanelProps): ReactElement {
  if (target.kind === 'pdf') {
    return <PdfPreview key={target.assetPath} target={target} onClose={onClose} />
  }
  return <NotePreview key={target.path} path={target.path} onClose={onClose} />
}
