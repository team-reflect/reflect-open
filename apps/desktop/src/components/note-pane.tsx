import { useCallback, useRef, type ReactElement } from 'react'
import { isDaily } from '@reflect/core'
import { BacklinksPanel } from '@/components/backlinks-panel'
import { InlineAlert } from '@/components/inline-alert'
import { NoteConflictBanner } from '@/components/note-conflict-banner'
import { ProtectedNoteView } from '@/components/protected-note-view'
import { SyncConflictNotice } from '@/components/sync-conflict-notice'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { useImagePersistence } from '@/editor/use-image-persistence'
import { useNoteDocument } from '@/editor/use-note-document'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import { WikiAutocomplete } from '@/editor/wiki-autocomplete'
import { createNoteWithTitle } from '@/lib/create-note'
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
}

/** The seeded title for a brand-new (missing) ordinary note. */
const UNTITLED_SEED = '# Untitled\n'

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
export function NotePane({
  path,
  lazy = false,
  autoFocus = false,
  onAutoFocused,
  className,
  editorClassName,
  gutterClassName,
}: NotePaneProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const graphRoot = graph?.root ?? null
  const generation = graph?.generation ?? null
  const dailyNote = isDaily(path)
  const document = useNoteDocument(path, generation, {
    createIfMissing: lazy,
    // Daily notes are excluded from rename tracking: their date labels are
    // stream chrome, not content (decided 2026-06-09).
    trackRenames: !dailyNote,
    // A missing ordinary note opens as a titled template (old Reflect's
    // new-note flow): the seed only reaches disk if the user edits, and the
    // title is selected on focus so typing names the note. Daily notes stay
    // unseeded — the date is their identity.
    missingSeed: lazy && !dailyNote ? UNTITLED_SEED : undefined,
  })
  const { options: images, saveError: imageSaveError } = useImagePersistence(
    graphRoot,
    generation,
  )
  const onWikiLinkClick = useWikiLinkNavigation(generation)

  // The `[[` autocomplete's create row: make the file; the popover inserts the
  // link text either way (a failed create just leaves an unresolved link).
  const createFromAutocomplete = useCallback(
    async (title: string) => {
      if (generation !== null) {
        await createNoteWithTitle(title, generation)
      }
    },
    [generation],
  )

  const bindEditor = document.bindEditor
  // Read through a ref so the callback's identity never changes with the
  // snapshot — React re-invokes a changed callback ref (null, then handle),
  // which would re-focus an editor the user is already typing in.
  const missingRef = useRef(false)
  missingRef.current = document.missing
  const handleRef = useCallback(
    (handle: NoteEditorHandle | null) => {
      bindEditor(handle)
      if (handle && autoFocus) {
        // A seeded new note focuses with "Untitled" selected so typing names
        // it; selectTitle falls back to a plain focus when there's no heading
        // (e.g. a lazy daily note).
        if (missingRef.current) {
          handle.selectTitle()
        } else {
          handle.focus()
        }
        onAutoFocused?.()
      }
    },
    [bindEditor, autoFocus, onAutoFocused],
  )

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
    // conflict notice — with its raw-text resolution actions — leads the view.
    return (
      <div className={cn(gutterClassName, className)}>
        <SyncConflictNotice path={path} className="mb-4" />
        <ProtectedNoteView content={document.initialContent} />
        <BacklinksPanel path={path} />
      </div>
    )
  }

  return (
    <div className={cn('relative', className)} aria-label={`Editing ${path}`}>
      <div className={gutterClassName}>
        {document.error !== null ? (
          <InlineAlert tone="error" className="mb-4">
            Saving failed: {document.error}. Your edits are kept in the editor and the next
            successful save will persist them.
          </InlineAlert>
        ) : null}

        {imageSaveError !== null ? (
          <InlineAlert tone="error" className="mb-4">
            Couldn’t save the pasted image: {imageSaveError}. It was not added to the note.
          </InlineAlert>
        ) : null}

        {document.conflict !== null ? (
          <NoteConflictBanner
            onKeepMine={document.keepMine}
            onLoadTheirs={document.loadTheirs}
          />
        ) : null}

        <SyncConflictNotice path={path} className="mb-4" />
      </div>

      <NoteEditor
        key={path}
        initialContent={document.initialContent}
        onChange={document.onEditorChange}
        markMode={settings.editorMarkdownSyntax}
        spellCheck={settings.editorSpellCheck}
        images={images}
        onWikiLinkClick={onWikiLinkClick}
        className={cn(gutterClassName, editorClassName)}
        handleRef={handleRef}
      >
        <WikiAutocomplete onCreate={createFromAutocomplete} />
      </NoteEditor>

      <div className={gutterClassName}>
        <BacklinksPanel path={path} />
      </div>
    </div>
  )
}
