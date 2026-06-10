import { useCallback, type ReactElement } from 'react'
import { isDaily } from '@reflect/core'
import { BacklinksPanel } from '@/components/backlinks-panel'
import { InlineAlert } from '@/components/inline-alert'
import { NoteConflictBanner } from '@/components/note-conflict-banner'
import { ProtectedNoteView } from '@/components/protected-note-view'
import { RelatedNotes } from '@/components/related-notes'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import { useImagePersistence } from '@/editor/use-image-persistence'
import { useNoteDocument } from '@/editor/use-note-document'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation'
import { WikiAutocomplete } from '@/editor/wiki-autocomplete'
import { createNoteWithTitle } from '@/lib/create-note'
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
export function NotePane({
  path,
  lazy = false,
  autoFocus = false,
  onAutoFocused,
}: NotePaneProps): ReactElement {
  const { graph } = useGraph()
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
        <ProtectedNoteView content={document.initialContent} />
        <BacklinksPanel path={path} />
      </div>
    )
  }

  return (
    <div className="relative" aria-label={`Editing ${path}`}>
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
        markMode={settings.editorMarkdownSyntax}
        images={images}
        onWikiLinkClick={onWikiLinkClick}
        handleRef={handleRef}
      >
        <WikiAutocomplete onCreate={createFromAutocomplete} />
      </NoteEditor>

      <BacklinksPanel path={path} />
      <RelatedNotes path={path} />
    </div>
  )
}
