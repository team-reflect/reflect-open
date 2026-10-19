import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createDocumentBinding,
  INITIAL_NOTE_SNAPSHOT,
  type DocumentBinding,
  type NoteSessionSnapshot,
  type RenameCoordinator,
} from '@reflect/core'
import { useMaybeGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import type { NoteEditorHandle } from './note-editor.tsx'
import { checkRoundTrip } from './roundtrip.ts'

/**
 * React adapter over the `@reflect/core` document state machine
 * (`NoteSessionService`): one session per open path, wired to
 * the watcher event stream (through `OpenDocumentsService`) and the editor's
 * imperative handle. All save/merge/protection semantics live in core's
 * `note-session-service.ts`, and the create/adopt/teardown/hand-off lifecycle
 * (a rename retargets the live session and the route follows, Plan 17) lives
 * in core's `document-binding.ts` — this hook only adapts both to React.
 */

export interface NoteDocument extends NoteSessionSnapshot {
  /**
   * Wire to the editor: every document change enters the pipeline here.
   */
  onEditorChange: (markdown: string) => void
  /**
   * Wire to the editor's imperative handle (reload and merged-save application).
   */
  bindEditor: (handle: NoteEditorHandle | null) => void
  /**
   * Stable identity of the underlying session: increments when a session is
   * *created*, not when a rename retargets one (Plan 17). Key the editor on
   * this instead of the path, so a note following its title to a new filename
   * keeps its live editor — cursor, selection, undo history and all.
   */
  sessionEpoch: number
}

export interface NoteDocumentOptions {
  /**
   * Treat a missing file as an empty note instead of an error. The file is then
   * created by the first save — Plan 06's lazy daily-note contract: opening a
   * day never litters the graph; writing does.
   */
  createIfMissing?: boolean | undefined
  /**
   * Maintain inbound `[[links]]` when this note's settled title changes. The
   * coordinator separately requires a direct `notes/*.md` path with valid
   * Reflect ULID frontmatter before moving a file onto its title's slug, so
   * adopted and stable-path notes keep their filenames.
   */
  trackRenames?: boolean | undefined
  /**
   * Markdown to seed a missing note's buffer with (the new-note title
   * template). Requires `createIfMissing`; see `NoteSessionOptions.missingSeed`
   * for the lazy-contract semantics.
   */
  missingSeed?: string | undefined
}

/**
 * @param path graph-relative path of the open note; the session writes to the
 *   graph open when it is created, and is read-only while no graph is open.
 */
export function useNoteDocument(path: string | null, options?: NoteDocumentOptions): NoteDocument {
  const createIfMissing = options?.createIfMissing ?? false
  const trackRenames = options?.trackRenames ?? false
  const missingSeed = options?.missingSeed
  const [snapshot, setSnapshot] = useState<NoteSessionSnapshot>(INITIAL_NOTE_SNAPSHOT)
  const editorRef = useRef<NoteEditorHandle | null>(null)
  /**
   * The pane's lifecycle policy object — one per hook instance.
   */
  const { noteSessions, openDocuments, titleRename } = useCoreServices()
  const [binding] = useState<DocumentBinding<RenameCoordinator>>(() => {
    return createDocumentBinding({ openDocuments })
  })

  // The session is keyed on whether a graph is open, not on its generation:
  // reopening the *same* graph bumps the generation without remounting the
  // pane, and the session's writes follow that reopen on their own.
  const canWrite = useMaybeGraph()?.graph != null

  useEffect(() => {
    if (!path) {
      return
    }
    const { session, created } = binding.bind(path, {
      // The auto-rename lifecycle (Plan 07b/17) is owned by the coordinator —
      // the tracker, the rewrite chain, alias placement, and the file move.
      coordinator: () => (trackRenames ? titleRename.createCoordinator({ path }) : null),
      session: (coordinator) => {
        return noteSessions.create({
          path,
          readOnly: !canWrite,
          classify: checkRoundTrip,
          onSnapshot: setSnapshot,
          applyContent: (markdown) => editorRef.current?.setMarkdown(markdown),
          reconcilePendingEditorInput: () => {
            // Meowdown 0.43.1 synchronously emits onDocChange only when this
            // reconciliation changes the document. Discarding the always-
            // returned snapshot avoids dirtying files whose serialization is
            // merely normalized relative to their on-disk Markdown.
            editorRef.current?.getMarkdown()
          },
          onContent: coordinator
            ? (content, origin) => coordinator.content(content, origin)
            : undefined,
          createIfMissing,
          missingSeed,
        })
      },
    })
    if (created) {
      session.load()
    }
    return () => binding.unbind(path)
  }, [
    binding,
    noteSessions,
    titleRename,
    path,
    canWrite,
    createIfMissing,
    trackRenames,
    missingSeed,
  ])

  // Flush pending edits when the window loses focus, and register with the
  // app-global registry so quit-time teardown (window close, ⌘Q — paths where
  // unmount effects never run) can flush this buffer too. The session's flush
  // resolves once the write has landed, which is what makes quit wait.
  useEffect(() => {
    if (!path) {
      return
    }
    const flush = (): void => {
      // Capture the pair at event time: reading the binding again after the
      // flush promise resolves could observe a *different* note's session/
      // coordinator if navigation switched panes mid-flush — settling that
      // one early would fire its renames without quiet period or blur.
      const session = binding.session()
      const coordinator = binding.coordinator()
      // Blur is a settle point for title renames — but only after the flushed
      // save lands, so the tracker has seen the final title. (Quit-time flush
      // + settle is the open-documents service's job, not this listener's.)
      void session?.flush().then(() => coordinator?.settle())
    }
    window.addEventListener('blur', flush)
    return () => {
      window.removeEventListener('blur', flush)
    }
  }, [binding, path])

  const onEditorChange = useCallback(
    (markdown: string) => {
      binding.session()?.editorChanged(markdown)
    },
    [binding],
  )

  const bindEditor = useCallback((handle: NoteEditorHandle | null) => {
    if (handle === null) {
      // React detaches this consumer ref while the child editor handle is
      // still live. Reconcile before dropping it; onDocChange updates the
      // current session synchronously only when pending input changed state.
      editorRef.current?.getMarkdown()
    }
    editorRef.current = handle
  }, [])

  return {
    ...snapshot,
    onEditorChange,
    bindEditor,
    sessionEpoch: binding.epoch(),
  }
}
