import { memo, useCallback, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ExitBoundaryHandler } from '@meowdown/core'
import { detectConflictMarkers, isDaily, isTemplatePath, untitledNoteSeed } from '@reflect/core'
import { BacklinksPanel } from '@/components/backlinks-panel'
import { ConflictNoteView } from '@/components/conflict-note-view'
import { InlineAlert } from '@/components/inline-alert'
import { NoteConflictBanner } from '@/components/note-conflict-banner'
import { ProtectedNoteView } from '@/components/protected-note-view'
import { SuggestedContactCard } from '@/components/suggested-contact-card'
import { SyncConflictNotice } from '@/components/sync-conflict-notice'
import { EditorAiKeymap } from '@/editor/ai-menu/editor-ai-keymap'
import { useEditorAiMenu } from '@/editor/ai-menu/use-editor-ai-menu'
import { editorBodyWithDefaultBullet } from '@/editor/default-bullet'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry'
import { markModeFromSyntax } from '@/editor/mark-mode'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { resolveAssetFileLink, useAssetPersistence } from '@/editor/use-asset-persistence'
import { useEditorAutocomplete } from '@/editor/use-editor-autocomplete'
import { useNoteDocument } from '@/editor/use-note-document'
import { useTagNavigation } from '@/editor/use-tag-navigation'
import { useTemplateSlashItems } from '@/editor/use-template-slash-items'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import { useWikiLinkHoverPreview } from '@/editor/use-wiki-link-hover-preview'
import { isTouchEditorSurface } from '@/lib/platform-surface'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

interface NotePaneProps {
  /** Graph-relative path of the note to edit. */
  path: string
  /** Treat a missing file as empty (created on first keystroke) — Plan 06. */
  lazy?: boolean
  /** Focus the editor when it mounts (the navigated-to day/note). */
  autoFocus?: boolean
  /**
   * Where the caret lands when {@link autoFocus} applies: the document start
   * (default — a seeded new note's empty H1, so typing names the note) or the
   * end of the note's content (append-style capture, e.g. the mobile daily
   * double-tap).
   */
  autoFocusSelection?: 'start' | 'end'
  /** Called once the autofocus actually happened (the editor mounted). */
  onAutoFocused?: () => void
  /**
   * Extra classes for the pane root in every state (loading, error,
   * protected, editing). The note route uses this to make the pane a
   * stretching flex column so the editor can fill the viewport.
   */
  className?: string
  /**
   * Extra classes for the editable area (e.g. the daily stream's per-day
   * `min-h-*`). Applied to the contenteditable root, so the reserved space
   * is click-to-focus — and to the loading/error placeholders, so a pane
   * holds the same space in every state instead of collapsing and re-expanding
   * around the stream's scroll anchor while its note arrives.
   */
  editorClassName?: string
  /**
   * Horizontal gutter applied *inside* the pane's pieces — the contenteditable
   * itself plus the chrome around it (alerts, backlinks, loading/error text) —
   * rather than on the pane root. The daily stream uses this so each day's row
   * spans the pane's full width (dividers run edge to edge) while the gutter
   * stays part of the editor's click-to-focus area.
   */
  gutterClassName?: string
  /**
   * Render the built-in desktop backlinks panel below the note (default).
   * The mobile surfaces pass `false` and mount their own touch-chrome
   * `IncomingBacklinks` section over the same data layer.
   */
  showBacklinks?: boolean
  /**
   * The daily stream's day key for this pane (omitted by non-daily callers).
   * Required for {@link registerHandle} and {@link onExitBoundary} to identify
   * which day fired.
   */
  dailyDate?: string
  /**
   * Register (or, with `null`, unregister) this pane's editor handle with the
   * daily stream, so it can move the caret here from an adjacent day. Keyed by
   * {@link dailyDate}.
   */
  registerHandle?: (date: string, handle: NoteEditorHandle | null) => void
  /**
   * The caret tried to leave this pane's top (`'up'`) / bottom (`'down'`) edge.
   * The daily stream moves focus to the adjacent day; returns `true` when it
   * did, so the editor consumes the key.
   */
  onExitBoundary?: (date: string, direction: 'up' | 'down') => boolean
}

/**
 * One open note: the editor bound to its on-disk document via the Plan 05 save
 * pipeline (debounced atomic writes, watcher-driven external reload, and a
 * non-destructive conflict prompt when an external change races unsaved edits).
 * Notes the editor can't faithfully round-trip open **protected** (read-only)
 * so a converter gap can never silently rewrite a file. Plan 06 mounts one of
 * these per day in the daily stream.
 *
 * The pane is composition only: document semantics live in
 * `useNoteDocument`/`note-session.ts`, link-click behavior in
 * `useWikiLinkNavigation`, and the banners are shared components.
 */
export function NotePaneComponent({
  path,
  lazy = false,
  autoFocus = false,
  autoFocusSelection = 'start',
  onAutoFocused,
  className,
  editorClassName,
  gutterClassName,
  showBacklinks = true,
  dailyDate,
  registerHandle,
  onExitBoundary,
}: NotePaneProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const generation = graph?.generation ?? null
  const dailyNote = isDaily(path)
  // Templates rename via file operations only (settings, or outside the app):
  // the rename pipeline's slug targets live under `notes/`, so tracking a
  // template's title would move it out of `templates/`. The untitled `id:`
  // seed is skipped for the same reason — it exists to feed that pipeline.
  const template = isTemplatePath(path)
  // One seed per (pane, path): a fresh seed carries a fresh `id:`, and a mere
  // re-render must not mint a new identity (the session is keyed on the seed).
  // Re-mint during render when the path changes — only the committed render's
  // seed reaches the session, so the transient stale render is harmless, and
  // this avoids writing a ref during render.
  const needsSeed = lazy && !dailyNote && !template
  const [seed, setSeed] = useState(() => ({ path, seed: untitledNoteSeed() }))
  if (needsSeed && seed.path !== path) {
    setSeed({ path, seed: untitledNoteSeed() })
  }
  const document = useNoteDocument(path, generation, {
    createIfMissing: lazy,
    // Daily notes are excluded from rename tracking: their date labels are
    // stream chrome, not content (decided 2026-06-09). Templates too — see
    // the `template` note above.
    trackRenames: !dailyNote && !template,
    // A missing ordinary note opens as a name-me template (old Reflect's
    // new-note flow): the seed — `id:` frontmatter plus an empty H1 the
    // caret lands in, ghosted "Untitled" by the title placeholder — only
    // reaches disk if the user edits, and typing names the note. Daily
    // notes stay unseeded — the date is their identity.
    ...(needsSeed ? { missingSeed: seed.seed } : {}),
  })
  const {
    resolveImageUrl,
    resolveAssetOpenPath,
    openAsset,
    saveFile,
    resolveFileInfo,
    saveError,
  } = useAssetPersistence(generation, path)
  const renderWikilinkHoverCard = useWikiLinkHoverPreview({
    generation,
    graphKey: graph?.root ?? null,
    dateFormat: settings.dateFormat,
    resolveImageUrl,
    resolveAssetOpenPath,
  })
  const onWikiLinkClick = useWikiLinkNavigation(generation)
  const onTagClick = useTagNavigation()
  const { onWikilinkSearch, onTagSearch } = useEditorAutocomplete()

  const bindEditor = document.bindEditor
  const aiEditorRef = useRef<NoteEditorHandle | null>(null)
  // The registry entry this pane made, so unmount removes exactly it (a
  // remount of the same path may already have re-registered).
  const registeredHandle = useRef<{ path: string; handle: NoteEditorHandle } | null>(null)
  // The `/` menu's template rows insert into this pane's own editor, read
  // through the registry ref at select time (a late resolve after the pane
  // unmounted must insert nowhere rather than somewhere stale).
  const onSlashMenuSearch = useTemplateSlashItems(
    useCallback(() => registeredHandle.current?.handle ?? null, []),
  )
  const handleRef = useCallback(
    (handle: NoteEditorHandle | null) => {
      bindEditor(handle)
      aiEditorRef.current = handle
      if (handle === null) {
        if (registeredHandle.current !== null) {
          unregisterNoteEditorHandle(
            registeredHandle.current.path,
            registeredHandle.current.handle,
          )
          registeredHandle.current = null
        }
      } else {
        registerNoteEditorHandle(path, handle)
        registeredHandle.current = { path, handle }
      }
      if (dailyDate !== undefined) {
        registerHandle?.(dailyDate, handle)
      }
      if (handle && autoFocus) {
        // By default the caret lands at the document start — for a seeded
        // new note that is the empty H1, so typing names the note. An `end`
        // selection moves it (and the scroll) to the note's content end.
        handle.focus()
        if (autoFocusSelection === 'end') {
          handle.setSelection('end')
        }
        onAutoFocused?.()
      }
    },
    [bindEditor, path, dailyDate, registerHandle, autoFocus, autoFocusSelection, onAutoFocused],
  )

  const aiMenu = useEditorAiMenu({
    path,
    sessionEpoch: document.sessionEpoch,
    editorRef: aiEditorRef,
  })


  const handleExitBoundary: ExitBoundaryHandler | undefined = useMemo(() => {
    if (!dailyDate || !onExitBoundary) {
      return
    }
    return ({ direction }) => {
      return onExitBoundary(dailyDate, direction)
    }
  }, [dailyDate, onExitBoundary])

  if (document.status === 'loading') {
    // `reflect-note-loading` keeps the hint invisible for the first beat:
    // local reads resolve in milliseconds, and the text flashing on every
    // daily-stream row reads as flicker while the stream anchors.
    return (
      <div
        className={cn(
          'reflect-note-loading px-1 py-2 text-sm text-text-muted',
          gutterClassName,
          editorClassName,
          className,
        )}
      >
        Loading note…
      </div>
    )
  }

  if (document.status === 'error') {
    return (
      <div
        role="alert"
        className={cn(
          'px-1 py-2 text-sm text-red-500',
          gutterClassName,
          editorClassName,
          className,
        )}
      >
        Couldn’t open {path}: {document.error}
      </div>
    )
  }

  if (document.protected) {
    // Sync-conflicted notes land here (markers classify as lossy), so the
    // conflict notice — with its raw-text resolution actions — leads the
    // view, and the file renders with each block's sides color-coded instead
    // of the generic read-only dump (whose converter-gap alert would only
    // double up on the conflict explanation).
    const conflicted = detectConflictMarkers(document.initialContent)
    return (
      <div className={cn(gutterClassName, className)}>
        <SyncConflictNotice path={path} className="mb-4" />
        {conflicted ? (
          <ConflictNoteView content={document.initialContent} />
        ) : (
          <ProtectedNoteView content={document.initialContent} />
        )}
        {showBacklinks ? <BacklinksPanel path={path} /> : null}
      </div>
    )
  }

  // A note that opens with an empty body starts on an empty bullet when the
  // setting is on (old Reflect's every-note default). The seed only changes what
  // the editor shows; persistence is untouched, so a not-yet-created daily
  // placeholder stays uncreated until the user types — see `default-bullet.ts`.
  const editorSeed = editorBodyWithDefaultBullet(
    document.initialContent,
    settings.editorDefaultBullet,
  )

  return (
    <div className={cn('relative', className)} aria-label={`Editing ${path}`}>
      <div className={gutterClassName}>
        {document.error !== null ? (
          <InlineAlert tone="error" className="mb-4">
            Saving failed: {document.error}. Your edits are kept in the editor and the next
            successful save will persist them.
          </InlineAlert>
        ) : null}

        {saveError !== null ? (
          <InlineAlert tone="error" className="mb-4">
            Couldn’t save the {saveError.kind === 'image' ? 'pasted image' : 'file'}:{' '}
            {saveError.message}. It was not added to the note.
          </InlineAlert>
        ) : null}

        {document.conflict !== null ? (
          <NoteConflictBanner
            onKeepMine={document.keepMine}
            onLoadTheirs={document.loadTheirs}
          />
        ) : null}

        <SyncConflictNotice path={path} className="mb-4" />

        {/* Daily notes are date-titled, so a contact can never match one —
            the hook gates on it, and skipping the mount keeps the stream lean.
            Keyed by path: a note switch must not carry one card's busy/error
            state into the next note's card. */}
        {!dailyNote ? <SuggestedContactCard key={path} path={path} /> : null}
      </div>

      <NoteEditor
        // Keyed on the session, not the path: a rename retargets the live
        // session under a new filename (Plan 17), and remounting the editor
        // for that would throw away the cursor mid-thought.
        key={document.sessionEpoch}
        initialContent={editorSeed}
        onChange={document.onEditorChange}
        markMode={markModeFromSyntax(settings.editorMarkdownSyntax)}
        spellCheck={settings.editorSpellCheck}
        smoothCaretAnimation={settings.editorSmoothCaretAnimation}
        timeFormat={settings.timeFormat}
        bulletAfterHeading={settings.editorBulletAfterHeading}
        // The grip drag-reorders blocks and the "+" inserts a paragraph below.
        blockHandle={true}
        resolveImageUrl={resolveImageUrl}
        resolveAssetOpenPath={resolveAssetOpenPath}
        openAsset={openAsset}
        saveFile={saveFile}
        // Claims `assets/…` links (what saveFile inserts for a dropped
        // non-image file) so they render as file pills, sized by
        // resolveFileInfo.
        resolveFileLink={resolveAssetFileLink}
        resolveFileInfo={resolveFileInfo}
        onWikiLinkClick={onWikiLinkClick}
        {...(generation !== null && !isTouchEditorSurface()
          ? { renderWikilinkHoverCard }
          : {})}
        onTagClick={onTagClick}
        onWikilinkSearch={onWikilinkSearch}
        onTagSearch={onTagSearch}
        {...(aiMenu.onSelectionMenuSearch !== undefined
          ? { onSelectionMenuSearch: aiMenu.onSelectionMenuSearch }
          : {})}
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

      {showBacklinks ? (
        <div className={gutterClassName}>
          <BacklinksPanel path={path} />
        </div>
      ) : null}
    </div>
  )
}

export const NotePane = memo(NotePaneComponent)
