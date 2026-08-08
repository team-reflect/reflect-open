import { useCallback, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isAppError, splitFrontmatter } from '@reflect/core'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownPreview } from '@/editor/markdown-preview'
import { useAssetPersistence } from '@/editor/use-asset-persistence'
import { useBacklinkNavigation } from '@/hooks/use-backlink-navigation'
import { usePdfAnnotations } from '@/lib/annotations/annotations-store'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { readExistingNoteSource } from '@/lib/read-existing-note-source'
import { useGraph } from '@/providers/graph-provider'
import type { PreviewPanelTarget } from '@/providers/preview-panel-provider'
import { AnnotationList } from './annotation-list'
import {
  AnnotationToolbar,
  DEFAULT_ANNOTATION_COLOR,
  type AnnotationColor,
  type AnnotationTool,
} from './annotation-toolbar'
import { HighlightLayer, type NormalizedRect } from './highlight-layer'
import { PdfViewerShell } from './pdf-viewer-shell'

/**
 * The resident preview panel's content, opened for a PDF or note link. Owns
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

/** The PDF branch: viewer + annotation overlay under one toolbar and list. */
function PdfPreview({ target, onClose }: PdfPreviewProps): ReactElement {
  const { graph } = useGraph()
  const generation = graph?.generation ?? null
  const { annotations, addAnnotation, removeAnnotation } = usePdfAnnotations(
    target.assetPath,
    generation,
  )
  const [mode, setMode] = useState<AnnotationTool>('browse')
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_ANNOTATION_COLOR)
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  return (
    <div className="flex h-full min-h-0 flex-col text-text">
      <PdfViewerShell
        assetPath={target.assetPath}
        {...(target.page !== undefined ? { initialPage: target.page } : {})}
      >
        <HighlightLayer
          annotations={annotations}
          mode={mode}
          color={color}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAdd}
        />
      </PdfViewerShell>
      <AnnotationToolbar
        mode={mode}
        onModeChange={setMode}
        color={color}
        onColorChange={setColor}
        selectedId={selectedId}
        onDeleteSelected={handleDeleteSelected}
        onClose={onClose}
      />
      <AnnotationList annotations={annotations} selectedId={selectedId} onSelect={setSelectedId} />
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

interface PreviewContextSidebarProps {
  /** The open preview panel's target; never null here (the shell hides the region). */
  target: PreviewPanelTarget
  onClose: () => void
}

/**
 * Renders the resident preview panel for its target. Keyed on the target's
 * subject so switching PDFs (or notes) remounts the branch and resets its
 * interaction state instead of leaking the previous document's selection.
 */
export function PreviewContextSidebar({
  target,
  onClose,
}: PreviewContextSidebarProps): ReactElement {
  if (target.kind === 'pdf') {
    return <PdfPreview key={target.assetPath} target={target} onClose={onClose} />
  }
  return <NotePreview key={target.path} path={target.path} onClose={onClose} />
}
