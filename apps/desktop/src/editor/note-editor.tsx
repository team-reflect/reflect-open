import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { errorMessage, type TimeFormat } from '@reflect/core'
import {
  type AcceptPendingReplacementOptions,
  type ExitBoundaryHandler,
  type FileClickHandler,
  type FileInfoResolver,
  type FileLinkResolver,
  type MarkMode,
  type StartPendingReplacementOptions,
} from '@meowdown/core'
import {
  MeowdownEditor,
  type EditorHandle,
  type PendingReplacementResolveHandler,
  type SelectionMenuSearchHandler,
  type SlashMenuSearchHandler,
  type TagSearchHandler,
  type WikilinkSearchHandler,
} from '@meowdown/react'
import { EditorInputTraits } from '@/editor/editor-input-traits'
import { FormattingToolbarBridge } from '@/editor/formatting-toolbar-bridge'
import {
  IMAGE_LIGHTBOX_TRANSITION_NAME,
  ImageLightbox,
  type LightboxImage,
} from '@/editor/image-lightbox'
import { isOpenableExternalUrl } from '@/editor/open-external-link'
import { isTouchEditorSurface } from '@/lib/platform-surface'
import { useLightboxTransition } from '@/editor/use-lightbox-transition'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { isDeepLinkUrl } from '@/lib/deep-links/parse'
import { isNewWindowClick, openDeepLinkInNewWindow } from '@/lib/windows/open-in-new-window'
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
  /**
   * Insert a parsed markdown fragment at the cursor as one undoable edit —
   * how commands add content to the focused note (Insert template…,
   * Attach file…). An active selection collapses first and is never deleted:
   * these are host-initiated inserts, not pastes. Unlike {@link setMarkdown},
   * this fires `onChange`, so the insertion flows into the save pipeline like
   * typing. Empty/whitespace-only markdown is a no-op.
   */
  insertMarkdown(markdown: string): void
  focus(): void
  /**
   * Move the caret to a document edge and scroll it into view. Used for
   * cross-note arrow navigation in the daily stream (jump to the end of the
   * previous day / the start of the next day).
   */
  setSelection(position: 'start' | 'end'): void
  /** The current selection's text (blocks separated by blank lines). */
  getSelectedText(): string
  /** Open the selection AI menu (no-op on an empty selection). */
  openSelectionMenu(): void
  /** Stage a pending replacement over a range; false when the range is invalid. */
  startPendingReplacement(options: StartPendingReplacementOptions): boolean
  /** Append streamed text to the staged replacement's preview. */
  appendPendingReplacementText(text: string): void
  /** Apply the staged replacement as one edit; `mode` overrides its placement. */
  acceptPendingReplacement(options?: AcceptPendingReplacementOptions): void
  /** Clear the staged replacement without touching the document. */
  discardPendingReplacement(): void
}

interface NoteEditorProps {
  /** Initial markdown, read only on first render (uncontrolled). */
  initialContent: string
  /** Called with the current markdown whenever the user edits the document. */
  onChange?: (markdown: string) => void
  /** How markdown syntax characters are shown. */
  markMode?: MarkMode
  /** Whether the browser underlines misspelled words (default on). */
  spellCheck?: boolean
  /**
   * Clock format for the time the `/now` slash command inserts (the
   * `timeFormat` setting). Defaults to `12h`.
   */
  timeFormat?: TimeFormat
  /**
   * Whether Enter at the end of a heading starts a bullet on the next line
   * (the `editorBulletAfterHeading` setting). Off by default.
   */
  bulletAfterHeading?: boolean
  /**
   * Whether to show meowdown's per-block gutter handle: a grip to drag-reorder
   * blocks and a "+" to insert a paragraph below. Off by default. The main note
   * editor opts in; one-line surfaces like the inline task editor leave it off so
   * no stray grip appears beside them.
   */
  blockHandle?: boolean
  /** Resolve an image `![…](…)` source to a displayable URL; unresolved images are skipped. */
  resolveImageUrl?: (src: string) => string | null
  /**
   * Vet a source (an image `src` or a link `href`) as a graph-relative asset
   * path for {@link openAsset}. Returns null for remote or unsafe sources.
   */
  resolveAssetOpenPath?: (src: string) => string | null
  /** Open a vetted graph-relative asset path in the OS default application. */
  openAsset?: (path: string) => Promise<void> | void
  /**
   * Persist a pasted/dropped file (any kind) and return its markdown
   * destination, or null to decline. meowdown inserts `![](dest)` for images
   * and `[name](dest)` for everything else.
   */
  saveFile?: (file: File) => Promise<string | null>
  /**
   * Claim a `[label](url)` link as a file attachment, rendered as an inline
   * file pill instead of a plain link. Clicking a pill routes through the
   * same href handling as a link click (asset opener, deep links, OS
   * opener). Must be pure; read once on first render, like `initialContent`.
   */
  resolveFileLink?: FileLinkResolver
  /** Resolve the file size a rendered file pill shows next to its name. */
  resolveFileInfo?: FileInfoResolver
  /**
   * Click on a `[[wiki link]]`. `event` is the originating click (or the
   * Mod-Enter key press that followed the link) — handlers read its
   * modifiers, e.g. ⌘-click opens the target in a new window.
   */
  onWikiLinkClick?: (target: string, event?: MouseEvent | KeyboardEvent) => void
  /** Click on an inline `#tag`. The tag name arrives without the leading `#`. */
  onTagClick?: (tag: string) => void
  /** Search notes for the `[[` autocomplete menu. */
  onWikilinkSearch?: WikilinkSearchHandler
  /** Search tags for the `#` autocomplete menu. */
  onTagSearch?: TagSearchHandler
  /**
   * Search prompts for the selection AI menu. Omitting it disables the menu
   * and its selection affordance entirely (e.g. for `private: true` notes).
   */
  onSelectionMenuSearch?: SelectionMenuSearchHandler
  /** Extra controls in the pending-replacement preview footer (e.g. Retry). */
  pendingReplacementActions?: ReactNode
  /** Called when a staged replacement is accepted or discarded. */
  onPendingReplacementResolve?: PendingReplacementResolveHandler
  /** Host rows for the `/` insert menu (note templates). */
  onSlashMenuSearch?: SlashMenuSearchHandler
  /** Handler when pressing ArrowUp/ArrowDown at the document edge. */
  onExitBoundary?: ExitBoundaryHandler | undefined
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

export function NoteEditor({
  initialContent,
  onChange,
  markMode = 'hide',
  spellCheck = true,
  timeFormat = '12h',
  bulletAfterHeading = false,
  blockHandle = false,
  resolveImageUrl,
  resolveAssetOpenPath,
  openAsset,
  saveFile,
  resolveFileLink,
  resolveFileInfo,
  onWikiLinkClick,
  onTagClick,
  onWikilinkSearch,
  onTagSearch,
  onSelectionMenuSearch,
  pendingReplacementActions,
  onPendingReplacementResolve,
  onSlashMenuSearch,
  onExitBoundary,
  children,
  titlePlaceholder,
  className,
  handleRef,
}: NoteEditorProps): ReactElement {
  const innerRef = useRef<EditorHandle>(null)

  // Latest callbacks, read through refs so a changing prop identity never
  // rebuilds meowdown's extensions (the uncontrolled-editor contract).
  // TODO: This violates "Rule of hooks". Refactor this later.
  const onChangeRef = useRef(onChange)
  const onWikiLinkClickRef = useRef(onWikiLinkClick)
  const onTagClickRef = useRef(onTagClick)
  const resolveImageUrlRef = useRef(resolveImageUrl)
  const resolveAssetOpenPathRef = useRef(resolveAssetOpenPath)
  const openAssetRef = useRef(openAsset)
  const saveFileRef = useRef(saveFile)
  const resolveFileInfoRef = useRef(resolveFileInfo)
  const onExitBoundaryRef = useRef(onExitBoundary)
  useLayoutEffect(() => {
    onChangeRef.current = onChange
    onWikiLinkClickRef.current = onWikiLinkClick
    onTagClickRef.current = onTagClick
    resolveImageUrlRef.current = resolveImageUrl
    resolveAssetOpenPathRef.current = resolveAssetOpenPath
    openAssetRef.current = openAsset
    saveFileRef.current = saveFile
    resolveFileInfoRef.current = resolveFileInfo
    onExitBoundaryRef.current = onExitBoundary
  })

  const {
    item: lightboxImage,
    open: openLightbox,
    close: closeLightbox,
  } = useLightboxTransition<HTMLImageElement, LightboxImage>()

  useImperativeHandle(
    handleRef,
    (): NoteEditorHandle => ({
      getMarkdown: () => innerRef.current?.getMarkdown() ?? '',
      setMarkdown: (markdown) => innerRef.current?.setMarkdown(markdown),
      // meowdown ≥0.33 collapses an active selection itself, so an insert
      // can never delete selected text — plain delegation is the whole story.
      insertMarkdown: (markdown) => innerRef.current?.insertMarkdown(markdown),
      focus: () => innerRef.current?.focus(),
      setSelection: (position) => innerRef.current?.setSelection(position),
      getSelectedText: () => innerRef.current?.getSelectedText() ?? '',
      openSelectionMenu: () => innerRef.current?.openSelectionMenu(),
      startPendingReplacement: (options) =>
        innerRef.current?.startPendingReplacement(options) ?? false,
      appendPendingReplacementText: (text) =>
        innerRef.current?.appendPendingReplacementText(text),
      acceptPendingReplacement: (options) => innerRef.current?.acceptPendingReplacement(options),
      discardPendingReplacement: () => innerRef.current?.discardPendingReplacement(),
    }),
    [],
  )

  const handleDocChange = useCallback(() => {
    onChangeRef.current?.(innerRef.current?.getMarkdown() ?? '')
  }, [])

  const handleExitBoundary: ExitBoundaryHandler = useCallback(
    (options) => onExitBoundaryRef.current?.(options) ?? false,
    [],
  )

  const handleWikilinkClick = useCallback(
    (payload: { target: string; event: MouseEvent | KeyboardEvent }) =>
      onWikiLinkClickRef.current?.(payload.target, payload.event),
    [],
  )
  const handleTagClick = useCallback(
    (payload: { tag: string }) => onTagClickRef.current?.(payload.tag),
    [],
  )
  const handleResolveImageUrl = useCallback(
    (src: string) => resolveImageUrlRef.current?.(src) ?? undefined,
    [],
  )
  const handleFilePaste = useCallback(
    async (file: File) => (await saveFileRef.current?.(file)) ?? undefined,
    [],
  )
  const handleLinkClick = useCallback(
    // The event may also be the Mod-Enter key press that followed the link
    // (meowdown ≥0.33).
    ({ href, event }: { href: string; event: MouseEvent | KeyboardEvent }) => {
      // A graph-relative `assets/…` href (an attachment link) opens through
      // the generation-pinned asset command, never the URL opener — which
      // would receive a meaningless relative string.
      const assetPath = resolveAssetOpenPathRef.current?.(href) ?? null
      if (assetPath !== null) {
        void Promise.resolve(openAssetRef.current?.(assetPath)).catch((cause) => {
          console.error('open asset failed:', errorMessage(cause))
        })
        return
      }
      // A `reflect://` link routes through the in-app deep-link pipeline —
      // the OS opener would deny the scheme (and a round-trip could land on
      // another installed flavor). ⌘-click sends an *addressing* link to a
      // new window instead; a declined open (capture link, browser dev)
      // degrades to the normal dispatch.
      if (isDeepLinkUrl(href)) {
        if (isNewWindowClick(event)) {
          void openDeepLinkInNewWindow(href).then((opened) => {
            if (!opened) {
              dispatchDeepLink(href)
            }
          })
          return
        }
        dispatchDeepLink(href)
        return
      }
      if (!isOpenableExternalUrl(href)) {
        return
      }
      void openUrl(href).catch((cause) => {
        console.error('open link failed:', errorMessage(cause))
      })
    },
    [],
  )
  // A file pill is a claimed link, so a click on it routes exactly like a
  // link click: `assets/…` through the asset opener, anything else through
  // the deep-link/URL path.
  const handleFileClick: FileClickHandler = useCallback(
    ({ href, event }) => handleLinkClick({ href, event }),
    [handleLinkClick],
  )
  const handleResolveFileInfo: FileInfoResolver = useCallback(
    (href) => resolveFileInfoRef.current?.(href),
    [],
  )
  const handleImageClick = useCallback(
    ({ src, alt, event }: { src: string; alt: string; event: MouseEvent }) => {
      const displayUrl = resolveImageUrlRef.current?.(src) ?? null
      if (displayUrl === null) {
        return
      }
      // The clicked target is the `<img>` or its `.md-image-preview` wrapper;
      // the source element drives the View Transition zoom.
      const sourceImage =
        event.target instanceof HTMLElement
          ? event.target.closest('.md-image-preview')?.querySelector('img') ?? null
          : null
      openLightbox(sourceImage, {
        src: displayUrl,
        alt,
        openPath: resolveAssetOpenPathRef.current?.(src) ?? null,
        openImage: openAssetRef.current ?? null,
        transitionName: IMAGE_LIGHTBOX_TRANSITION_NAME,
      })
    },
    [openLightbox],
  )
  const handleOpenLightboxImage = useCallback((image: LightboxImage) => {
    if (image.openPath !== null && image.openImage !== null) {
      void Promise.resolve(image.openImage(image.openPath)).catch((cause) => {
        console.error('open image failed:', errorMessage(cause))
      })
    }
  }, [])

  return (
    <>
      <MeowdownEditor
        handleRef={innerRef}
        mode={markMode}
        initialMarkdown={initialContent}
        // On the touch surface spellcheck is pinned off regardless of the
        // setting: iOS derives the keyboard's smart-quotes/smart-dashes traits
        // from it at focus time, and smart punctuation corrupts markdown
        // syntax ([[ wiki links, code spans, --- fences) — Plan 19 gate.
        // Autocorrect is independent and stays on (EditorInputTraits).
        spellCheck={isTouchEditorSurface() ? false : spellCheck}
        // Reflect's implementation-neutral `12h`/`24h` maps to meowdown's
        // `12`/`24` here at the boundary, like `markModeFromSyntax`.
        timeFormat={timeFormat === '24h' ? '24' : '12'}
        bulletAfterHeading={bulletAfterHeading}
        blockHandle={blockHandle}
        editorClassName={cn('reflect-editor', className)}
        {...(titlePlaceholder !== undefined ? { placeholder: titlePlaceholder } : {})}
        onDocChange={handleDocChange}
        onWikilinkClick={handleWikilinkClick}
        onTagClick={handleTagClick}
        onLinkClick={handleLinkClick}
        onImageClick={handleImageClick}
        {...(onWikilinkSearch !== undefined ? { onWikilinkSearch } : {})}
        {...(onTagSearch !== undefined ? { onTagSearch } : {})}
        {...(onSelectionMenuSearch !== undefined ? { onSelectionMenuSearch } : {})}
        {...(pendingReplacementActions !== undefined ? { pendingReplacementActions } : {})}
        {...(onPendingReplacementResolve !== undefined ? { onPendingReplacementResolve } : {})}
        {...(onSlashMenuSearch !== undefined ? { onSlashMenuSearch } : {})}
        resolveImageUrl={handleResolveImageUrl}
        onFilePaste={handleFilePaste}
        {...(resolveFileLink !== undefined ? { resolveFileLink } : {})}
        resolveFileInfo={handleResolveFileInfo}
        onFileClick={handleFileClick}
        onExitBoundary={handleExitBoundary}
      >
        <EditorInputTraits />
        <FormattingToolbarBridge />
        {children}
      </MeowdownEditor>
      <ImageLightbox
        image={lightboxImage}
        onClose={closeLightbox}
        onOpenImage={handleOpenLightboxImage}
      />
    </>
  )
}
