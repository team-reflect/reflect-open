import { useCallback, useMemo, useRef, type ReactElement } from 'react'
import type { ExitBoundaryHandler, SearchStatus } from '@meowdown/core'
import type { NoteSession } from '@reflect/core'
import { NoteSaveAlerts } from '@/components/note-save-alerts.tsx'
import { SuggestedContactCard } from '@/components/suggested-contact-card.tsx'
import { EditorAiKeymap } from '@/editor/ai-menu/editor-ai-keymap.tsx'
import { useEditorAiMenu } from '@/editor/ai-menu/use-editor-ai-menu.tsx'
import { editorBodyWithDefaultBullet } from '@/editor/default-bullet.ts'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import { markModeFromSyntax } from '@/editor/mark-mode.ts'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useAssetPersistence } from '@/editor/use-asset-persistence.ts'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete.ts'
import { useTagNavigation } from '@/editor/use-tag-navigation.ts'
import { useTemplateSlashItems } from '@/editor/use-template-slash-items.ts'
import { useMarkdownLinkClick } from '@/editor/use-markdown-link-click.ts'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { useWikiLinkHoverPreview } from '@/editor/use-wiki-link-hover-preview.tsx'
import { cn } from '@/lib/utils.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useNoteSearchQuery, useNoteSearchReport } from '@/providers/note-find-provider.tsx'
import {
  useDateFormat,
  useEditorBulletAfterHeading,
  useEditorDefaultBullet,
  useEditorMarkdownSyntax,
  useEditorSmoothCaretAnimation,
  useEditorSpellCheck,
  useTimeFormat,
} from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

interface SessionEditorViewProps {
  /**
   * The session's path. Every path-addressed feature of the editor (assets,
   * links, AI, the handle registry, Find) uses this one; during a note switch
   * it briefly differs from the route's path.
   */
  path: string
  session: NoteSession
  /** The body the editor opens on. */
  initialContent: string
  /** The session's save error, if its last write failed. */
  saveError: string | null
  dailyNote: boolean
  autoFocus: boolean
  autoFocusSelection: 'start' | 'end'
  onAutoFocused: (() => void) | undefined
  /** Classes for the chrome around the editor (alerts, cards). */
  gutterClassName: string | undefined
  /** Classes for the contenteditable root. */
  editorClassName: string | undefined
  dailyDate: string | undefined
  registerHandle: ((date: string, handle: NoteEditorHandle | null) => void) | undefined
  onExitBoundary: ((date: string, direction: 'up' | 'down') => boolean) | undefined
}

/**
 * The editor of one note session. Mounted once per session (the pane keys it
 * on the session's epoch), so everything here belongs to that session alone:
 * a rename re-renders it under the new path, a note switch replaces it.
 */
export function SessionEditorView({
  path,
  session,
  initialContent,
  saveError,
  dailyNote,
  autoFocus,
  autoFocusSelection,
  onAutoFocused,
  gutterClassName,
  editorClassName,
  dailyDate,
  registerHandle,
  onExitBoundary,
}: SessionEditorViewProps): ReactElement {
  const graph = useGraphInfo()
  const dateFormat = useDateFormat()
  const timeFormat = useTimeFormat()
  const editorMarkdownSyntax = useEditorMarkdownSyntax()
  const editorSpellCheck = useEditorSpellCheck()
  const editorSmoothCaretAnimation = useEditorSmoothCaretAnimation()
  const editorDefaultBullet = useEditorDefaultBullet()
  const editorBulletAfterHeading = useEditorBulletAfterHeading()
  const { platform, linkPreview } = useCoreServices()

  const {
    resolveImageUrl,
    resolveWikiEmbed,
    resolveAssetOpenPath,
    resolveFileLink,
    openAsset,
    saveFile,
    resolveFileInfo,
    saveError: assetSaveError,
  } = useAssetPersistence(path)
  const renderWikilinkHoverCard = useWikiLinkHoverPreview({
    dateFormat,
  })
  const onWikiLinkClick = useWikiLinkNavigation()
  const onLinkClick = useMarkdownLinkClick(path)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()
  const hasGraph = graph !== null
  const resolveLinkPreview = useMemo(
    () => (hasGraph ? linkPreview.createResolver(path) : undefined),
    [hasGraph, linkPreview, path],
  )

  // Find is one session per window: only the targeted note gets a query, and
  // only its status reaches the Find bar.
  const searchQuery = useNoteSearchQuery(path)
  const reportSearchStatus = useNoteSearchReport()
  const handleSearchChange = useCallback(
    (status: SearchStatus) => reportSearchStatus(path, status),
    [path, reportSearchStatus],
  )

  const editorRef = useRef<NoteEditorHandle | null>(null)
  // The `/` menu's template rows insert into this editor, read at select time
  // (a late resolve after the unmount must insert nowhere rather than
  // somewhere stale).
  const onSlashMenuSearch = useTemplateSlashItems(useCallback(() => editorRef.current, []))
  const aiMenu = useEditorAiMenu({ path, editorRef })

  const handleRef = useCallback(
    (handle: NoteEditorHandle) => {
      session.attachEditor(handle)
      editorRef.current = handle
      registerNoteEditorHandle(path, handle)
      if (dailyDate !== undefined) {
        registerHandle?.(dailyDate, handle)
      }
      if (autoFocus) {
        // By default the caret lands at the document start — for a seeded
        // new note that is the empty H1, so typing names the note. An `end`
        // selection moves it (and the scroll) to the note's content end.
        handle.focus()
        if (autoFocusSelection === 'end') {
          handle.setSelection('end')
        }
        onAutoFocused?.()
      }
      return () => {
        // Runs while the handle is still live, so the session can still read
        // the editor's last input.
        session.attachEditor(null)
        editorRef.current = null
        unregisterNoteEditorHandle(path, handle)
        if (dailyDate !== undefined) {
          registerHandle?.(dailyDate, null)
        }
      }
    },
    [session, path, dailyDate, registerHandle, autoFocus, autoFocusSelection, onAutoFocused],
  )
  const onChange = useCallback((markdown: string) => session.editorChanged(markdown), [session])

  const handleExitBoundary: ExitBoundaryHandler | undefined = useMemo(() => {
    if (!dailyDate || !onExitBoundary) {
      return
    }
    return ({ direction }) => {
      return onExitBoundary(dailyDate, direction)
    }
  }, [dailyDate, onExitBoundary])

  // A note that opens with an empty body starts on an empty bullet when the
  // setting is on (old Reflect's every-note default). The seed only changes what
  // the editor shows; persistence is untouched, so a not-yet-created daily
  // placeholder stays uncreated until the user types — see `default-bullet.ts`.
  const editorSeed = editorBodyWithDefaultBullet(initialContent, editorDefaultBullet)

  return (
    <>
      <div className={gutterClassName}>
        <NoteSaveAlerts saveError={saveError} assetSaveError={assetSaveError} />

        {/* Daily notes are date-titled, so a contact can never match one —
            the hook gates on it, and skipping the mount keeps the stream lean.
            Keyed by path: a rename must not carry one card's busy/error state
            into the next note's card. */}
        {!dailyNote ? <SuggestedContactCard key={path} path={path} /> : null}
      </div>

      <NoteEditor
        initialContent={editorSeed}
        onChange={onChange}
        markMode={markModeFromSyntax(editorMarkdownSyntax)}
        spellCheck={editorSpellCheck}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        smoothCaretAnimation={editorSmoothCaretAnimation}
        timeFormat={timeFormat}
        bulletAfterHeading={editorBulletAfterHeading}
        backspaceDeletesEmptyFirstBlock={dailyNote}
        // The grip drag-reorders blocks and the "+" inserts a paragraph below.
        blockHandle={true}
        resolveImageUrl={resolveImageUrl}
        resolveWikiEmbed={resolveWikiEmbed}
        resolveAssetOpenPath={resolveAssetOpenPath}
        openAsset={openAsset}
        saveFile={saveFile}
        // Claims links to local attachments (what saveFile inserts for a
        // dropped non-image file, or a vault's own attachment links) so they
        // render as file pills, sized by resolveFileInfo.
        resolveFileLink={resolveFileLink}
        resolveFileInfo={resolveFileInfo}
        onWikiLinkClick={onWikiLinkClick}
        onLinkClick={onLinkClick}
        resolveLinkPreview={resolveLinkPreview}
        renderWikilinkHoverCard={
          graph !== null && !platform.surface.touchEditor ? renderWikilinkHoverCard : undefined
        }
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        onSelectionMenuSearch={aiMenu.onSelectionMenuSearch}
        pendingReplacementActions={aiMenu.pendingReplacementActions}
        onPendingReplacementResolve={aiMenu.onPendingReplacementResolve}
        onSlashMenuSearch={onSlashMenuSearch}
        // Daily notes carry no title semantics (the date is their subject),
        // so an empty leading H1 there is just an empty heading.
        {...(dailyNote ? {} : { titlePlaceholder: 'Untitled' })}
        // `reflect-note-surface` opts this primary editor into the reading
        // text size (Settings → Editor); compact MarkdownView previews that
        // also carry `reflect-editor` keep their own context size.
        className={cn('reflect-note-surface', gutterClassName, editorClassName)}
        handleRef={handleRef}
        onExitBoundary={handleExitBoundary}
      >
        <EditorAiKeymap onTrigger={aiMenu.openMenu} />
      </NoteEditor>
    </>
  )
}
