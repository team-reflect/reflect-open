import { memo, useState, type ReactElement } from 'react'
import { deferredCreationPolicy, isDaily } from '@reflect/core'
import { BacklinksPanel } from '@/components/backlinks-panel.tsx'
import { NoteLoading } from '@/components/note-loading.tsx'
import { NoteOpenError } from '@/components/note-open-error.tsx'
import { ProtectedNoteView } from '@/components/protected-note-view.tsx'
import { SessionEditorView } from '@/components/session-editor-view.tsx'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useNoteDocument } from '@/editor/use-note-document.ts'
import { useXPostPreload } from '@/editor/use-x-post-preload.ts'
import { cn } from '@/lib/utils.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

interface NotePaneProps {
  /** Graph-relative path of the note to edit. */
  path: string
  /**
   * Request lazy creation. The pane permits it only for daily notes and the
   * explicit new-note ULID route; arbitrary missing paths fail closed.
   */
  lazy?: boolean | undefined
  /** Focus the editor when it mounts (the navigated-to day/note). */
  autoFocus?: boolean | undefined
  /**
   * Where the caret lands when {@link autoFocus} applies: the document start
   * (default — a seeded new note's empty H1, so typing names the note) or the
   * end of the note's content (append-style capture, e.g. the mobile daily
   * double-tap).
   */
  autoFocusSelection?: 'start' | 'end' | undefined
  /** Called once the autofocus actually happened (the editor mounted). */
  onAutoFocused?: (() => void) | undefined
  /**
   * Extra classes for the pane root in every state (loading, error,
   * protected, editing). The note route uses this to make the pane a
   * stretching flex column so the editor can fill the viewport.
   */
  className?: string | undefined
  /**
   * Extra classes for the editable area (e.g. the daily stream's per-day
   * `min-h-*`). Applied to the contenteditable root, so the reserved space
   * is click-to-focus — and to the loading/error placeholders, so a pane
   * holds the same space in every state instead of collapsing and re-expanding
   * around the stream's scroll anchor while its note arrives.
   */
  editorClassName?: string | undefined
  /**
   * Horizontal gutter applied *inside* the pane's pieces — the contenteditable
   * itself plus the chrome around it (alerts, backlinks, loading/error text) —
   * rather than on the pane root. The daily stream uses this so each day's row
   * spans the pane's full width (dividers run edge to edge) while the gutter
   * stays part of the editor's click-to-focus area.
   */
  gutterClassName?: string | undefined
  /**
   * Render the built-in desktop backlinks panel below the note (default).
   * The mobile surfaces pass `false` and mount their own touch-chrome
   * `IncomingBacklinks` section over the same data layer.
   */
  showBacklinks?: boolean | undefined
  /**
   * The daily stream's day key for this pane (omitted by non-daily callers).
   * Required for {@link registerHandle} and {@link onExitBoundary} to identify
   * which day fired.
   */
  dailyDate?: string | undefined
  /**
   * Register (or, with `null`, unregister) this pane's editor handle with the
   * daily stream, so it can move the caret here from an adjacent day. Keyed by
   * {@link dailyDate}.
   */
  registerHandle?: ((date: string, handle: NoteEditorHandle | null) => void) | undefined
  /**
   * The caret tried to leave this pane's top (`'up'`) / bottom (`'down'`) edge.
   * The daily stream moves focus to the adjacent day; returns `true` when it
   * did, so the editor consumes the key.
   */
  onExitBoundary?: ((date: string, direction: 'up' | 'down') => boolean) | undefined
}

/**
 * One open note: the editor bound to its on-disk document via the Plan 05 save
 * pipeline (debounced atomic writes, and watcher-driven external reload that
 * merges an external change into unsaved edits on the next write).
 * Notes the editor can't faithfully round-trip open **protected** (read-only)
 * so a converter gap can never silently rewrite a file. Plan 06 mounts one of
 * these per day in the daily stream.
 *
 * The pane is composition only: document semantics live in
 * `useNoteDocument`/`note-session.ts`, and the editor of one session, with
 * everything addressed by its path, is `SessionEditorView`.
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
  const { noteCreation } = useCoreServices()
  const dailyNote = isDaily(path)
  const policy = deferredCreationPolicy(path)
  const lazyCreate = lazy && policy.lazyCreatable
  // One seed per (pane, path): a fresh seed carries a fresh `id:`, and a mere
  // re-render must not mint a new identity (the session is keyed on the seed).
  // Re-mint during render when the path changes — only the committed render's
  // seed reaches the session, so the transient stale render is harmless, and
  // this avoids writing a ref during render.
  const needsSeed = lazyCreate && policy.seedsUntitled
  const [seed, setSeed] = useState(() => ({ path, seed: noteCreation.untitledNoteSeed() }))
  if (needsSeed && seed.path !== path) {
    setSeed({ path, seed: noteCreation.untitledNoteSeed() })
  }
  const document = useNoteDocument(path, {
    createIfMissing: lazyCreate,
    // Every editable regular note maintains title-addressed links and
    // title-mirroring backlink displays. The coordinator separately limits
    // title-derived file moves to Reflect-managed notes.
    trackRenames: policy.trackRenames,
    // A missing ordinary note opens as a name-me template (old Reflect's
    // new-note flow): the seed — `id:` frontmatter plus an empty H1 the
    // caret lands in, ghosted "Untitled" by the title placeholder — only
    // reaches disk if the user edits, and typing names the note. Daily
    // notes stay unseeded — the date is their identity.
    missingSeed: needsSeed ? seed.seed : undefined,
  })
  const { snapshot, session, epoch } = document

  const editorContent =
    snapshot.status === 'ready' && !snapshot.protected ? snapshot.initialContent : null
  const xPostsReady = useXPostPreload(editorContent)

  if (
    session === null ||
    snapshot.path === null ||
    snapshot.status === 'loading' ||
    (editorContent !== null && !xPostsReady)
  ) {
    return <NoteLoading className={cn(gutterClassName, editorClassName, className)} />
  }

  if (snapshot.status === 'error') {
    return (
      <NoteOpenError
        path={path}
        message={snapshot.error}
        className={cn(gutterClassName, editorClassName, className)}
      />
    )
  }

  if (snapshot.protected) {
    return (
      <div className={cn(gutterClassName, className)}>
        <ProtectedNoteView content={snapshot.initialContent} />
        {showBacklinks ? <BacklinksPanel path={path} /> : null}
      </div>
    )
  }

  return (
    <div className={cn('relative', className)} aria-label={`Editing ${path}`}>
      <SessionEditorView
        // Keyed on the session, not the path: a rename retargets the live
        // session under a new filename (Plan 17), and remounting the editor
        // for that would throw away the cursor mid-thought.
        key={epoch}
        path={snapshot.path}
        session={session}
        initialContent={snapshot.initialContent}
        isPrivate={snapshot.isPrivate}
        saveError={snapshot.error}
        dailyNote={dailyNote}
        autoFocus={autoFocus}
        autoFocusSelection={autoFocusSelection}
        onAutoFocused={onAutoFocused}
        gutterClassName={gutterClassName}
        editorClassName={editorClassName}
        dailyDate={dailyDate}
        registerHandle={registerHandle}
        onExitBoundary={onExitBoundary}
      />

      {showBacklinks ? (
        <div className={gutterClassName}>
          <BacklinksPanel path={path} />
        </div>
      ) : null}
    </div>
  )
}

export const NotePane = memo(NotePaneComponent)
