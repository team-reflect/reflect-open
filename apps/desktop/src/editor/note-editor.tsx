import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { openPath } from '@tauri-apps/plugin-opener'
import { type MarkMode } from '@meowdown/core'
import {
  MeowdownEditor,
  type EditorHandle,
  type TagSearchHandler,
  type WikilinkSearchHandler,
} from '@meowdown/react'
import '@meowdown/core/style.css'
import '@meowdown/react/style.css'
import { ImageClickExtension } from '@/editor/image-click-extension'
import {
  IMAGE_LIGHTBOX_TRANSITION_NAME,
  ImageLightbox,
  createLightboxImage,
} from '@/editor/image-lightbox'
import { useLightboxTransition } from '@/editor/use-lightbox-transition'
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
  /**
   * Whether Enter at the end of a heading starts a bullet on the next line
   * (the `editorBulletAfterHeading` setting). Off by default.
   */
  bulletAfterHeading?: boolean
  /** Resolve an image `![…](…)` source to a displayable URL; unresolved images are skipped. */
  resolveImageUrl?: (src: string) => string | null
  /** Resolve an image `![…](…)` source to a native file path for Preview. */
  resolveImageOpenPath?: (src: string) => string | null
  /** Persist a pasted/dropped image file and return its markdown `src`. */
  saveImage?: (file: File) => Promise<string | null>
  /** Called when persisting a pasted/dropped image throws. */
  onImageSaveError?: (error: unknown, file: File) => void
  /** Click on a `[[wiki link]]`. */
  onWikiLinkClick?: (target: string) => void
  /** Search notes for the `[[` autocomplete menu. */
  onWikilinkSearch?: WikilinkSearchHandler
  /** Search tags for the `#` autocomplete menu. */
  onTagSearch?: TagSearchHandler
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
  /**
   * Extra nodes rendered inside meowdown's ProseKit context (rich modes) — e.g.
   * a feature keymap via `useKeymap`. They mount alongside the always-on
   * bullet-after-heading keymap.
   */
  children?: ReactNode
}

function useLatestRef<Value>(value: Value): MutableRefObject<Value> {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

export function NoteEditor({
  initialContent,
  onChange,
  markMode = 'focus',
  spellCheck = true,
  bulletAfterHeading = false,
  resolveImageUrl,
  resolveImageOpenPath,
  saveImage,
  onImageSaveError,
  onWikiLinkClick,
  onWikilinkSearch,
  onTagSearch,
  children,
  titlePlaceholder,
  className,
  handleRef,
}: NoteEditorProps): ReactElement {
  const innerRef = useRef<EditorHandle>(null)
  const imageOpenPathByUrlRef = useRef(new Map<string, string>())

  // Latest callbacks, read through refs so a changing prop identity never
  // rebuilds meowdown's extensions (the uncontrolled-editor contract).
  const onChangeRef = useLatestRef(onChange)
  const onWikiLinkClickRef = useLatestRef(onWikiLinkClick)
  const resolveImageUrlRef = useLatestRef(resolveImageUrl)
  const resolveImageOpenPathRef = useLatestRef(resolveImageOpenPath)
  const saveImageRef = useLatestRef(saveImage)
  const onImageSaveErrorRef = useLatestRef(onImageSaveError)
  const createImageLightboxItem = useCallback(
    (element: HTMLImageElement, transitionName: string) =>
      createLightboxImage(element, transitionName, imageOpenPathByUrlRef.current),
    [],
  )
  const imageLightbox = useLightboxTransition({
    transitionName: IMAGE_LIGHTBOX_TRANSITION_NAME,
    createItem: createImageLightboxItem,
  })

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
  }, [onChangeRef])
  const handleWikilinkClick = useCallback(
    (payload: { target: string }) => onWikiLinkClickRef.current?.(payload.target),
    [onWikiLinkClickRef],
  )
  const handleResolveImageUrl = useCallback(
    (src: string) => {
      const displayUrl = resolveImageUrlRef.current?.(src) ?? undefined
      if (displayUrl !== undefined) {
        const openPath = resolveImageOpenPathRef.current?.(src) ?? null
        if (openPath === null) {
          imageOpenPathByUrlRef.current.delete(displayUrl)
        } else {
          imageOpenPathByUrlRef.current.set(displayUrl, openPath)
        }
      }
      return displayUrl
    },
    [resolveImageOpenPathRef, resolveImageUrlRef],
  )
  const handleImagePaste = useCallback(
    async (file: File) => (await saveImageRef.current?.(file)) ?? undefined,
    [saveImageRef],
  )
  const handleImageSaveError = useCallback(
    (error: unknown, file: File) => onImageSaveErrorRef.current?.(error, file),
    [onImageSaveErrorRef],
  )
  const handleOpenLightboxImage = useCallback((image: { openPath: string | null }) => {
    if (image.openPath !== null) {
      void openPath(image.openPath, 'Preview').catch(() => {})
    }
  }, [])

  return (
    <>
      <MeowdownEditor
        handleRef={innerRef}
        mode={markMode}
        initialMarkdown={initialContent}
        spellCheck={spellCheck}
        bulletAfterHeading={bulletAfterHeading}
        editorClassName={cn('reflect-editor', className)}
        {...(titlePlaceholder !== undefined ? { placeholder: titlePlaceholder } : {})}
        onDocChange={handleDocChange}
        onWikilinkClick={handleWikilinkClick}
        {...(onWikilinkSearch !== undefined ? { onWikilinkSearch } : {})}
        {...(onTagSearch !== undefined ? { onTagSearch } : {})}
        resolveImageUrl={handleResolveImageUrl}
        onImagePaste={handleImagePaste}
        onImageSaveError={handleImageSaveError}
      >
        <ImageClickExtension onImageClick={imageLightbox.open} />
        {children}
      </MeowdownEditor>
      <ImageLightbox
        image={imageLightbox.item}
        onClose={imageLightbox.close}
        onOpenImage={handleOpenLightboxImage}
      />
    </>
  )
}
