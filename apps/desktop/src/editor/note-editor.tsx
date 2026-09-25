import { lightboxItemFromXPostMedia } from '@/editor/x-post-media-lightbox-item.ts'
import { useXPostResolver, X_MEDIA_URL_PROTOCOLS } from '@/editor/use-x-post-resolver.ts'
import { resolveYouTubeVideo } from '@/editor/youtube-video-resolver.ts'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { errorMessage, type TimeFormat } from '@reflect/core'
import type {
  AcceptPendingReplacementOptions,
  ExitBoundaryHandler,
  FileClickHandler,
  FileInfoResolver,
  FileLinkResolver,
  ImageClickHandler,
  LinkPreviewResolver,
  MarkMode,
  SearchStatus,
  StartPendingReplacementOptions,
  WikiEmbedResolver,
  WikilinkHoverHit,
  XPostMediaClickHandler,
  YouTubeVideoClickHandler,
} from '@meowdown/core'
import {
  MeowdownEditor,
  useLightbox,
  WikilinkHoverCard,
  type EditorHandle,
  type PendingReplacementResolveHandler,
  type SelectionMenuSearchHandler,
  type SlashMenuSearchHandler,
  type TagSearchHandler,
  type WikilinkSearchHandler,
} from '@meowdown/react'
import { EditorInputTraits } from '@/editor/editor-input-traits.tsx'
import { FormattingToolbarBridge } from '@/editor/formatting-toolbar-bridge.tsx'
import { MediaLightbox } from '@/editor/media-lightbox.tsx'
import { isOpenableExternalUrl } from '@/editor/open-external-link.ts'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { isTouchEditorSurface } from '@/lib/platform-surface.ts'
import { isDeepLinkUrl } from '@/lib/deep-links/parse.ts'
import { useFollowDeepLink } from '@/lib/deep-links/use-follow-deep-link.ts'
import { openUrlSync } from '@/lib/open-url.ts'
import { cn } from '@/lib/utils.ts'

type WikilinkHoverRenderer = (hit: WikilinkHoverHit) => ReactNode | Promise<ReactNode>

// See apps/youtube-relay/README.md.
const YOUTUBE_RELAY_URL = 'https://youtube-relay-reflect.vercel.app/'

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
  /**
   * Reconcile pending native input, then serialize the current document to
   * Markdown. If reconciliation changes the document, `onChange` may run
   * synchronously before this method returns.
   */
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
  /** Select the next find match, wrapping at the document end. */
  findNext(): void
  /** Select the previous find match, wrapping at the document start. */
  findPrevious(): void
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
  /** Whether the caret animates between positions (default on). */
  smoothCaretAnimation?: boolean
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
   * no stray grip appears beside them. Always off on the touch surface, which
   * has no hover to reveal the grip.
   */
  blockHandle?: boolean
  /**
   * Resolve an image `![…](…)` source to a displayable URL; unresolved images
   * are skipped. Memoize it: a new identity means its answers changed (the
   * note's folder, the graph session, the attachment catalog), and every
   * rendered image re-resolves.
   */
  resolveImageUrl?: (src: string) => string | null
  /**
   * Classify Obsidian `![[target]]` embeds as images, file pills, or note
   * chips; `undefined` leaves the source literal. Memoize it like
   * {@link NoteEditorProps.resolveImageUrl}: a new identity re-resolves every
   * embed in the document.
   */
  resolveWikiEmbed?: WikiEmbedResolver
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
  onWikiLinkClick?: (options: { target: string; openInNewWindow: boolean }) => void
  /**
   * Click on a rendered Markdown link whose href is graph-local (scheme-less
   * and not an asset): a note link like `[Plan](./Plan.md)`. Receives the
   * authored href; the handler owns source-relative resolution.
   */
  onNoteLinkClick?: (options: { href: string; openInNewWindow: boolean }) => void
  /** Resolve privacy-gated metadata for an HTTP(S) link popup. */
  readonly resolveLinkPreview?: LinkPreviewResolver
  /**
   * Resolve the passive body of Meowdown's editor-scoped wiki-link hover
   * card. Resolving `null` (missing, ambiguous, or unavailable targets)
   * renders no card. Must be a stable function: a new identity re-runs the
   * resolution for the currently hovered link.
   */
  renderWikilinkHoverCard?: WikilinkHoverRenderer
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
  /**
   * Text to find in this note. Every match is highlighted and the first one at
   * or after the caret is selected; an empty string (the default) clears the
   * highlights and leaves the caret alone.
   */
  searchQuery?: string
  /** Called when this note's match count or selected match changes. */
  onSearchChange?: (status: SearchStatus) => void
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
  smoothCaretAnimation = true,
  timeFormat = '12h',
  bulletAfterHeading = false,
  blockHandle = false,
  resolveImageUrl,
  resolveWikiEmbed,
  resolveAssetOpenPath,
  openAsset,
  saveFile,
  resolveFileLink,
  resolveFileInfo,
  onWikiLinkClick,
  onNoteLinkClick,
  resolveLinkPreview,
  renderWikilinkHoverCard,
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
  searchQuery,
  onSearchChange,
  handleRef,
}: NoteEditorProps): ReactElement {
  const resolveXPost = useXPostResolver()
  const innerRef = useRef<EditorHandle>(null)
  const followDeepLink = useFollowDeepLink()

  // Latest callbacks, read through refs so a changing prop identity never
  // rebuilds meowdown's extensions (the uncontrolled-editor contract).
  // TODO: This violates "Rule of hooks". Refactor this later.
  const onChangeRef = useRef(onChange)
  const onWikiLinkClickRef = useRef(onWikiLinkClick)
  const onNoteLinkClickRef = useRef(onNoteLinkClick)
  const onTagClickRef = useRef(onTagClick)
  const resolveImageUrlRef = useRef(resolveImageUrl)
  const resolveWikiEmbedRef = useRef(resolveWikiEmbed)
  const resolveAssetOpenPathRef = useRef(resolveAssetOpenPath)
  const openAssetRef = useRef(openAsset)
  const saveFileRef = useRef(saveFile)
  const resolveFileInfoRef = useRef(resolveFileInfo)
  const onExitBoundaryRef = useRef(onExitBoundary)
  useLayoutEffect(() => {
    onChangeRef.current = onChange
    onWikiLinkClickRef.current = onWikiLinkClick
    onNoteLinkClickRef.current = onNoteLinkClick
    onTagClickRef.current = onTagClick
    resolveImageUrlRef.current = resolveImageUrl
    resolveWikiEmbedRef.current = resolveWikiEmbed
    resolveAssetOpenPathRef.current = resolveAssetOpenPath
    openAssetRef.current = openAsset
    saveFileRef.current = saveFile
    resolveFileInfoRef.current = resolveFileInfo
    onExitBoundaryRef.current = onExitBoundary
  })

  // meowdown resolves an image when it renders it and an embed when it parses
  // it, through the stable wrappers below; a resolver whose answers changed
  // must re-resolve what is already on screen. Compared against the
  // identities the rendered document last used, so a mount (or StrictMode's
  // remount) never refreshes.
  const renderedResolvers = useRef({ resolveImageUrl, resolveWikiEmbed })
  useEffect(() => {
    const rendered = renderedResolvers.current
    if (
      rendered.resolveImageUrl === resolveImageUrl &&
      rendered.resolveWikiEmbed === resolveWikiEmbed
    ) {
      return
    }
    renderedResolvers.current = { resolveImageUrl, resolveWikiEmbed }
    const editor = innerRef.current
    if (editor === null) {
      return
    }
    // Only a document holding an embed has parse-time output to redo; the
    // reparse re-resolves images too. Anything else re-resolves images in
    // place, leaving the document (and a composition in progress) alone.
    if (rendered.resolveWikiEmbed !== resolveWikiEmbed && editor.getMarkdown().includes('![[')) {
      editor.refreshMarkdownRendering()
    } else {
      editor.refreshImages()
    }
  }, [resolveImageUrl, resolveWikiEmbed])

  const lightbox = useLightbox()
  const openLightbox = lightbox.open
  // Captured when the lightbox opens, so a later graph switch cannot retarget it.
  const [openLightboxImage, setOpenLightboxImage] = useState<(() => void) | null>(null)

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
      appendPendingReplacementText: (text) => innerRef.current?.appendPendingReplacementText(text),
      acceptPendingReplacement: (options) => innerRef.current?.acceptPendingReplacement(options),
      discardPendingReplacement: () => innerRef.current?.discardPendingReplacement(),
      findNext: () => innerRef.current?.findNext(),
      findPrevious: () => innerRef.current?.findPrevious(),
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
    (payload: { target: string; event: MouseEvent | KeyboardEvent; mod: boolean }) =>
      onWikiLinkClickRef.current?.({ target: payload.target, openInNewWindow: payload.mod }),
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
  const handleResolveWikiEmbed: WikiEmbedResolver = useCallback(
    (embed) => resolveWikiEmbedRef.current?.(embed),
    [],
  )
  const handleFilePaste = useCallback(
    async (file: File) => (await saveFileRef.current?.(file)) ?? undefined,
    [],
  )
  const handleLinkClick = useCallback(
    // The event may also be the Mod-Enter key press that followed the link
    // (meowdown ≥0.33).
    ({ href, mod }: { href: string; event: MouseEvent | KeyboardEvent; mod: boolean }) => {
      // An attachment href (resolved from the note's folder) opens through
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
      // another installed flavor). ⌘-click or a spare-`mod` keyboard follow sends an
      // *addressing* link to a new window instead; a declined open (capture link, browser dev)
      // degrades to the normal dispatch.
      if (isDeepLinkUrl(href)) {
        followDeepLink({ href, openInNewWindow: mod })
        return
      }
      if (!isOpenableExternalUrl(href)) {
        // A scheme-less local href is a note link; the host resolves it
        // against this note's own directory.
        onNoteLinkClickRef.current?.({ href, openInNewWindow: mod })
        return
      }
      openUrlSync(href)
    },
    [followDeepLink],
  )
  // A file pill is a claimed link, so a click on it routes exactly like a
  // link click: an attachment through the asset opener, anything else through
  // the deep-link/URL path.
  const handleFileClick: FileClickHandler = useCallback(
    ({ href, event, mod }) => handleLinkClick({ href, event, mod }),
    [handleLinkClick],
  )
  const handleResolveFileInfo: FileInfoResolver = useCallback(
    (href) => resolveFileInfoRef.current?.(href),
    [],
  )
  const handleImageClick: ImageClickHandler = useCallback(
    // Touch surfaces deliver the tap's `touchend` instead of a click —
    // meowdown cancels it so iOS WebKit can't focus the editor (and raise
    // the keyboard) under the opening lightbox.
    ({ src, alt, element }) => {
      const displayUrl = resolveImageUrlRef.current?.(src) ?? null
      if (displayUrl === null) {
        return
      }
      const openPath = resolveAssetOpenPathRef.current?.(src) ?? null
      const openImage = openAssetRef.current ?? null
      setOpenLightboxImage(() =>
        openPath !== null && openImage !== null
          ? () => {
              void Promise.resolve(openImage(openPath)).catch((cause) => {
                console.error('open image failed:', errorMessage(cause))
              })
            }
          : null,
      )
      openLightbox({ type: 'image', src: displayUrl, alt }, element)
    },
    [openLightbox],
  )

  const handleXPostMediaClick: XPostMediaClickHandler = useCallback(
    (event) => {
      // Without this the card opens the photo URL or plays the video in place.
      event.preventDefault()
      setOpenLightboxImage(null)
      openLightbox(lightboxItemFromXPostMedia(event.detail.media), event.detail.element)
    },
    [openLightbox],
  )

  const handleYouTubeVideoClick: YouTubeVideoClickHandler = useCallback(
    (event) => {
      // Without this the card plays the video in place.
      event.preventDefault()
      setOpenLightboxImage(null)
      const { video, short, videoId, element } = event.detail
      openLightbox(
        {
          type: 'frame',
          src: `${YOUTUBE_RELAY_URL}#v=${videoId}`,
          title: video.title || 'YouTube video',
          poster: video.thumbnail_url,
          width: short ? 9 : 16,
          height: short ? 16 : 9,
        },
        element,
      )
    },
    [openLightbox],
  )

  return (
    <>
      <MeowdownEditor
        resolveXPost={resolveXPost}
        resolveYouTubeVideo={resolveYouTubeVideo}
        mediaUrlProtocols={X_MEDIA_URL_PROTOCOLS}
        handleRef={innerRef}
        mode={markMode}
        initialMarkdown={initialContent}
        // On the touch surface spellcheck is pinned off regardless of the
        // setting: iOS derives the keyboard's smart-quotes/smart-dashes traits
        // from it at focus time, and smart punctuation corrupts markdown
        // syntax ([[ wiki links, code spans, --- fences) — Plan 19 gate.
        // Autocorrect is independent and stays on (EditorInputTraits).
        spellCheck={isTouchEditorSurface() ? false : spellCheck}
        searchQuery={searchQuery ?? ''}
        {...(onSearchChange !== undefined ? { onSearchChange } : {})}
        // Reflect's implementation-neutral `12h`/`24h` maps to meowdown's
        // `12`/`24` here at the boundary, like `markModeFromSyntax`.
        timeFormat={timeFormat === '24h' ? '24' : '12'}
        caretGlide={smoothCaretAnimation}
        bulletAfterHeading={bulletAfterHeading}
        // Pinned off on the touch surface regardless of the caller: the grip is
        // revealed on hover and drag-reorders blocks with a pointer, neither of
        // which a touch webview can express. Turning it off also drops the drop
        // indicator, which meowdown gates on the same prop.
        blockHandle={isTouchEditorSurface() ? false : blockHandle}
        editorClassName={cn('reflect-editor', className)}
        {...(titlePlaceholder !== undefined ? { placeholder: titlePlaceholder } : {})}
        onDocChange={handleDocChange}
        onWikilinkClick={handleWikilinkClick}
        onTagClick={handleTagClick}
        onLinkClick={handleLinkClick}
        {...(resolveLinkPreview !== undefined ? { resolveLinkPreview } : {})}
        onImageClick={handleImageClick}
        onXPostMediaClick={handleXPostMediaClick}
        onYouTubeVideoClick={handleYouTubeVideoClick}
        {...(onWikilinkSearch !== undefined ? { onWikilinkSearch } : {})}
        {...(onTagSearch !== undefined ? { onTagSearch } : {})}
        {...(onSelectionMenuSearch !== undefined ? { onSelectionMenuSearch } : {})}
        {...(pendingReplacementActions !== undefined ? { pendingReplacementActions } : {})}
        {...(onPendingReplacementResolve !== undefined ? { onPendingReplacementResolve } : {})}
        {...(onSlashMenuSearch !== undefined ? { onSlashMenuSearch } : {})}
        resolveImageUrl={handleResolveImageUrl}
        resolveWikiEmbed={handleResolveWikiEmbed}
        resolveWikilink={resolveWikilink}
        onFilePaste={handleFilePaste}
        {...(resolveFileLink !== undefined ? { resolveFileLink } : {})}
        resolveFileInfo={handleResolveFileInfo}
        onFileClick={handleFileClick}
        onExitBoundary={handleExitBoundary}
      >
        <EditorInputTraits />
        {/* Only a pane that persists files gets the toolbar's attach button;
            `handleFilePaste` is the same handler meowdown pastes through. */}
        <FormattingToolbarBridge
          {...(saveFile !== undefined ? { saveFile: handleFilePaste } : {})}
        />
        {renderWikilinkHoverCard !== undefined ? (
          <WikilinkHoverCard>{renderWikilinkHoverCard}</WikilinkHoverCard>
        ) : null}
        {children}
      </MeowdownEditor>
      <MediaLightbox lightbox={lightbox} onOpenImage={openLightboxImage} />
    </>
  )
}
