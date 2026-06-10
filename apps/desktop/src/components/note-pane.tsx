import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { isDaily, resolveWikiTarget } from '@reflect/core'
import { BacklinksPanel } from '@/components/backlinks-panel'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { useImagePersistence } from '@/editor/use-image-persistence'
import { useNoteDocument } from '@/editor/use-note-document'
import { WikiAutocomplete } from '@/editor/wiki-autocomplete'
import { createNoteWithTitle } from '@/lib/create-note'
import { isIsoDate } from '@/lib/dates'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import { useRouter } from '@/routing/router'
import { routeForPath } from '@/routing/route'

interface NotePaneProps {
  /** Graph-relative path of the note to edit. */
  path: string
  /** Treat a missing file as empty (created on first keystroke) — Plan 06. */
  lazy?: boolean
  /** Focus the editor when it mounts (the navigated-to day/note). */
  autoFocus?: boolean
  /** Called once the autofocus actually happened (the editor mounted). */
  onAutoFocused?: () => void
}

/**
 * One open note: the editor bound to its on-disk document via the Plan 05 save
 * pipeline (debounced atomic writes, watcher-driven external reload, and a
 * non-destructive conflict prompt when an external change races unsaved edits).
 * Notes the editor can't faithfully round-trip open **protected** (read-only)
 * so a converter gap can never silently rewrite a file. Plan 06 mounts one of
 * these per day in the daily stream.
 */
export function NotePane({
  path,
  lazy = false,
  autoFocus = false,
  onAutoFocused,
}: NotePaneProps): ReactElement {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const { settings } = useSettings()
  const graphRoot = graph?.root ?? null
  const generation = graph?.generation ?? null
  const document = useNoteDocument(path, generation, {
    createIfMissing: lazy,
    // Daily notes are excluded from rename tracking: their date labels are
    // stream chrome, not content (decided 2026-06-09).
    trackRenames: !isDaily(path),
  })
  const { options: images, saveError: imageSaveError } = useImagePersistence(
    graphRoot,
    generation,
  )

  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  // Mod+click on a [[wiki link]]: resolve via the index; an unresolved ISO date
  // is still a valid daily target (created lazily on first write). An
  // unresolved non-date target is created and opened on the spot (Plan 07's
  // create-from-unresolved — frictionless, consistent with lazy dailies).
  const onWikiLinkClick = useCallback(
    (target: string) => {
      void (async () => {
        try {
          const resolution = await resolveWikiTarget(target)
          // The pane can unmount while resolution is in flight (route change,
          // graph switch) — a late navigate would yank the user somewhere
          // they've already left.
          if (unmountedRef.current) {
            return
          }
          if (resolution.kind === 'resolved') {
            navigate(routeForPath(resolution.ref))
          } else if (isIsoDate(resolution.text)) {
            navigate({ kind: 'daily', date: resolution.text })
          } else if (generation !== null && resolution.text.trim() !== '') {
            const created = await createNoteWithTitle(resolution.text, generation)
            if (!unmountedRef.current) {
              navigate({ kind: 'note', path: created })
            }
          }
        } catch (err) {
          console.error('wiki-link resolution failed:', err)
        }
      })()
    },
    [navigate, generation],
  )

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
  const handleRef = useCallback(
    (handle: NoteEditorHandle | null) => {
      bindEditor(handle)
      if (handle && autoFocus) {
        handle.focus()
        onAutoFocused?.()
      }
    },
    [bindEditor, autoFocus, onAutoFocused],
  )

  if (document.status === 'loading') {
    return (
      <div className="px-1 py-2 text-sm text-[color:var(--text-muted)]">Loading note…</div>
    )
  }

  if (document.status === 'error') {
    return (
      <div role="alert" className="px-1 py-2 text-sm text-red-500">
        Couldn’t open {path}: {document.error}
      </div>
    )
  }

  if (document.protected) {
    return (
      <div>
        <div
          role="alert"
          className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          This note contains markdown the editor can’t yet reproduce faithfully (for
          example task lists), so it’s open read-only to protect your file. Edit it in
          another tool for now.
        </div>
        <pre className="reflect-protected-note whitespace-pre-wrap text-sm leading-relaxed">
          {document.initialContent}
        </pre>
        <BacklinksPanel path={path} />
      </div>
    )
  }

  return (
    <div className="relative" aria-label={`Editing ${path}`}>
      {document.error !== null ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
        >
          Saving failed: {document.error}. Your edits are kept in the editor and the next
          successful save will persist them.
        </div>
      ) : null}

      {imageSaveError !== null ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300"
        >
          Couldn’t save the pasted image: {imageSaveError}. It was not added to the note.
        </div>
      ) : null}

      {document.conflict !== null ? (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <span className="min-w-0 flex-1">
            This note changed on disk while you had unsaved edits.
          </span>
          <button
            type="button"
            onClick={document.keepMine}
            className="rounded border border-current/30 px-2 py-0.5 font-medium"
          >
            Keep mine
          </button>
          <button
            type="button"
            onClick={document.loadTheirs}
            className="rounded border border-current/30 px-2 py-0.5 font-medium"
          >
            Load theirs
          </button>
        </div>
      ) : null}

      {document.dirty ? (
        <span
          aria-label="Unsaved changes"
          title="Unsaved changes"
          className="absolute -top-1 right-0 size-2 rounded-full bg-[var(--accent)]"
        />
      ) : null}

      <NoteEditor
        key={path}
        initialContent={document.initialContent}
        onChange={document.onEditorChange}
        markMode={settings.editorMarkMode}
        images={images}
        onWikiLinkClick={onWikiLinkClick}
        handleRef={handleRef}
      >
        <WikiAutocomplete onCreate={createFromAutocomplete} />
      </NoteEditor>

      <BacklinksPanel path={path} />
    </div>
  )
}
