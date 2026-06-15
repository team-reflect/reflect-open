import { useCallback, useImperativeHandle, useRef, type ReactElement, type Ref } from 'react'
import { type MarkMode } from '@meowdown/core'
import { MeowdownEditor, type EditorHandle, type WikilinkSearchHandler } from '@meowdown/react'
import '@meowdown/core/style.css'
import '@meowdown/react/style.css'
import { cn } from '@/lib/utils'

/**
 * Reflect's note editor: a thin wrapper over `@meowdown/react`'s
 * `<MeowdownEditor>`. meowdown owns the editing surface (wiki-link clicks,
 * image rendering/persistence, headings, placeholder, the `[[` menu); this
 * wrapper only adapts Reflect's prop shapes and exposes the imperative handle
 * the document pipeline binds to.
 *
 * The component is **uncontrolled**: `initialContent` is read once. Showing a
 * different note or reloading after an external change goes through the
 * imperative {@link NoteEditorHandle} (or a remount via `key`), never a prop
 * change. `setMarkdown` is silent (meowdown does not fire `onDocChange` for a
 * programmatic replacement), so an external reload never loops back as an edit.
 */

/** Imperative surface for note switching, reload, and save flushes. */
export interface NoteEditorHandle {
  /** Serialize the current document to markdown. */
  getMarkdown(): string
  /** Replace the document (note switch / external reload). */
  setMarkdown(markdown: string): void
  focus(): void
}

interface NoteEditorProps {
  /** Initial markdown, read only on first render (uncontrolled). */
  initialContent: string
  /** Called with the current markdown whenever the user edits the document. */
  onChange?: (markdown: string) => void
  /** How markdown syntax characters are shown; `focus` reveals them near the caret. */
  markMode?: MarkMode
  /** Whether the browser underlines misspelled words (default on). */
  spellCheck?: boolean
  /** Resolve an image `![…](…)` source to a displayable URL; unresolved images are skipped. */
  resolveImageUrl?: (src: string) => string | null
  /** Persist a pasted/dropped image file and return its markdown `src`. */
  saveImage?: (file: File) => Promise<string | null>
  /** Called when persisting a pasted/dropped image throws. */
  onImageSaveError?: (error: unknown, file: File) => void
  /** Click on a `[[wiki link]]`. */
  onWikiLinkClick?: (target: string) => void
  /** Search notes for the `[[` autocomplete menu. */
  onWikilinkSearch?: WikilinkSearchHandler
  /**
   * Ghost text over a leading empty H1 (the new-note flow's "Untitled");
   * omitted for documents without title semantics (the daily stream).
   */
  titlePlaceholder?: string
  /**
   * Extra classes for the editable root. The contenteditable is the editor's
   * root, so e.g. a `min-h-*` here makes the whole reserved area
   * click-to-focus (the daily stream uses this for per-day sizing).
   */
  className?: string
  /** Imperative handle (React 19 ref-as-prop). */
  handleRef?: Ref<NoteEditorHandle>
}

export function NoteEditor({
  initialContent,
  onChange,
  markMode = 'focus',
  spellCheck = true,
  resolveImageUrl,
  saveImage,
  onImageSaveError,
  onWikiLinkClick,
  onWikilinkSearch,
  titlePlaceholder,
  className,
  handleRef,
}: NoteEditorProps): ReactElement {
  const innerRef = useRef<EditorHandle>(null)

  // Latest callbacks, read through refs so a changing prop identity never
  // rebuilds meowdown's extensions (the uncontrolled-editor contract).
  // TODO: This violates "Rule of hooks". Refactor this later.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onWikiLinkClickRef = useRef(onWikiLinkClick)
  onWikiLinkClickRef.current = onWikiLinkClick
  const resolveImageUrlRef = useRef(resolveImageUrl)
  resolveImageUrlRef.current = resolveImageUrl
  const saveImageRef = useRef(saveImage)
  saveImageRef.current = saveImage
  const onImageSaveErrorRef = useRef(onImageSaveError)
  onImageSaveErrorRef.current = onImageSaveError

  useImperativeHandle(
    handleRef,
    (): NoteEditorHandle => ({
      getMarkdown: () => innerRef.current?.getMarkdown() ?? '',
      setMarkdown: (markdown) => innerRef.current?.setMarkdown(markdown),
      focus: () => innerRef.current?.focus(),
    }),
    [],
  )

  const handleDocChange = useCallback(() => {
    onChangeRef.current?.(innerRef.current?.getMarkdown() ?? '')
  }, [])
  const handleWikilinkClick = useCallback(
    (payload: { target: string }) => onWikiLinkClickRef.current?.(payload.target),
    [],
  )
  const handleResolveImageUrl = useCallback(
    (src: string) => resolveImageUrlRef.current?.(src) ?? undefined,
    [],
  )
  const handleImagePaste = useCallback(
    async (file: File) => (await saveImageRef.current?.(file)) ?? undefined,
    [],
  )
  const handleImageSaveError = useCallback(
    (error: unknown, file: File) => onImageSaveErrorRef.current?.(error, file),
    [],
  )

  return (
    <MeowdownEditor
      handleRef={innerRef}
      mode={markMode}
      initialMarkdown={initialContent}
      spellCheck={spellCheck}
      editorClassName={cn('reflect-editor', className)}
      placeholder={titlePlaceholder}
      onDocChange={handleDocChange}
      onWikilinkClick={handleWikilinkClick}
      onWikilinkSearch={onWikilinkSearch}
      resolveImageUrl={handleResolveImageUrl}
      onImagePaste={handleImagePaste}
      onImageSaveError={handleImageSaveError}
    />
  )
}
