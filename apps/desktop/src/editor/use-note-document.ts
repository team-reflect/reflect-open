import { useCallback, useEffect, useRef, useState } from 'react'
import { readNote, writeNote, type FileChange } from '@reflect/core'
import { useFileChanges } from '@/lib/use-file-changes'
import type { NoteEditorHandle } from './note-editor'
import { registerOpenDocument } from './open-documents'
import { createRenameCoordinator, type RenameCoordinator } from './rename-coordinator'
import {
  createNoteSession,
  INITIAL_NOTE_SNAPSHOT,
  type NoteSession,
  type NoteSessionSnapshot,
} from './note-session'
import { checkRoundTrip } from './roundtrip'

/**
 * React adapter over the {@link createNoteSession} document state machine: one
 * session per open `(path, generation)`, wired to the `@reflect/core` file
 * commands, the watcher event stream, and the editor's imperative handle. All
 * save/conflict/protection semantics live in `note-session.ts`.
 */

export interface NoteDocument extends NoteSessionSnapshot {
  /** Wire to the editor: every document change enters the pipeline here. */
  onEditorChange: (markdown: string) => void
  /** Wire to the editor's imperative handle (reload/conflict application). */
  bindEditor: (handle: NoteEditorHandle | null) => void
  /** Resolve a conflict by keeping the buffer (rewrites the file). */
  keepMine: () => void
  /** Resolve a conflict by loading the external content (discards the buffer). */
  loadTheirs: () => void
}

export interface NoteDocumentOptions {
  /**
   * Treat a missing file as an empty note instead of an error. The file is then
   * created by the first save — Plan 06's lazy daily-note contract: opening a
   * day never litters the graph; writing does.
   */
  createIfMissing?: boolean
  /**
   * Auto-rewrite inbound `[[links]]` when this note's settled title changes
   * (Plan 07b). Off for daily notes — their date labels are stream chrome,
   * not content.
   */
  trackRenames?: boolean
  /**
   * Markdown to seed a missing note's buffer with (the new-note title
   * template). Requires `createIfMissing`; see `NoteSessionOptions.missingSeed`
   * for the lazy-contract semantics.
   */
  missingSeed?: string
}

/**
 * @param path graph-relative path of the open note
 * @param generation the open graph's session generation (`GraphInfo.generation`);
 *   pins every write to that graph — Rust rejects a write whose generation is
 *   stale, so a flush racing a graph switch can't land in the new graph.
 */
export function useNoteDocument(
  path: string | null,
  generation: number | null,
  options?: NoteDocumentOptions,
): NoteDocument {
  const createIfMissing = options?.createIfMissing ?? false
  const trackRenames = options?.trackRenames ?? false
  const missingSeed = options?.missingSeed
  const [snapshot, setSnapshot] = useState<NoteSessionSnapshot>(INITIAL_NOTE_SNAPSHOT)
  const editorRef = useRef<NoteEditorHandle | null>(null)
  const sessionRef = useRef<NoteSession | null>(null)
  const coordinatorRef = useRef<RenameCoordinator | null>(null)
  /** Mirrors the snapshot's conflict for non-reactive checks (rename gating). */
  const conflictRef = useRef<string | null>(null)

  // Writes read the generation at write time, not at session creation, so the
  // session must NOT be keyed on `generation`: reopening the *same* graph bumps
  // it without remounting the pane, and recreating the session would dispose-
  // flush with a stale generation (rejected by Rust) and silently reload the
  // buffer from disk — losing unsaved edits. Cross-graph safety is preserved
  // because a real graph switch remounts the whole workspace (keyed by root):
  // the unmounted pane never re-renders, its ref keeps the old generation, and
  // Rust rejects its final flush instead of landing it in the new graph.
  const generationRef = useRef(generation)
  generationRef.current = generation
  const canWrite = generation !== null

  useEffect(() => {
    if (!path) {
      return
    }
    // The auto-rename lifecycle (Plan 07b) is owned by the coordinator — the
    // tracker, the rewrite chain, and alias placement live there. It holds no
    // pane state at all: session liveness comes from the open-documents
    // service, and status surfaces through the global operations store.
    const coordinator = trackRenames
      ? createRenameCoordinator({
          path,
          generation: () => generationRef.current,
          canFire: () => conflictRef.current === null,
        })
      : null
    coordinatorRef.current = coordinator

    const session = createNoteSession({
      path,
      io: {
        read: readNote,
        write: canWrite
          ? (forPath, contents) => {
              const current = generationRef.current
              if (current === null) {
                return Promise.reject(new Error('no graph generation available for save'))
              }
              return writeNote(forPath, contents, current)
            }
          : null,
      },
      classify: checkRoundTrip,
      onSnapshot: (snapshot) => {
        conflictRef.current = snapshot.conflict
        setSnapshot(snapshot)
      },
      applyContent: (markdown) => editorRef.current?.setMarkdown(markdown),
      onContent: coordinator ? coordinator.content : undefined,
      createIfMissing,
      missingSeed,
    })
    sessionRef.current = session
    // One registration covers everything app-global teardown needs: the
    // quit-time flush, settle-time rename work, and reopened-note lookups.
    const unregisterDocument = registerOpenDocument({
      session,
      settle: coordinator ? () => coordinator.settle() : undefined,
      settled: coordinator ? () => coordinator.settled() : undefined,
    })
    session.load()
    return () => {
      if (sessionRef.current === session) {
        sessionRef.current = null
      }
      if (coordinatorRef.current === coordinator) {
        coordinatorRef.current = null
      }
      // Unregister first: a rename settling from this teardown must not see
      // this session as "open" — its alias goes to disk (or to a reopened
      // pane's live session, which registers under the same path).
      unregisterDocument()
      // Disposal flushes pending edits to the session's own path — the
      // path-switch "final flush" lives here, not in cross-note bookkeeping.
      // The flush's landed save reaches the tracker via onContent('saved');
      // settle after it so a just-edited title still renames on the way out.
      const settled = session.flush()
      session.dispose()
      if (coordinator) {
        void settled.then(() => {
          coordinator.settle()
          coordinator.dispose()
        })
      }
    }
  }, [path, canWrite, createIfMissing, trackRenames, missingSeed])

  // External-change reconciliation via the watcher (Plan 04b events).
  const onFileChanges = useCallback(
    (changes: FileChange[]) => {
      if (changes.some((change) => change.path === path && change.kind === 'upsert')) {
        sessionRef.current?.externalChanged()
      }
    },
    [path],
  )
  useFileChanges(path ? onFileChanges : null)

  // Flush pending edits when the window loses focus, and register with the
  // app-global registry so quit-time teardown (window close, ⌘Q — paths where
  // unmount effects never run) can flush this buffer too. The session's flush
  // resolves once the write has landed, which is what makes quit wait.
  useEffect(() => {
    if (!path) {
      return
    }
    const flush = (): void => {
      // Capture the pair at event time: reading the refs again after the
      // flush promise resolves could observe a *different* note's session/
      // coordinator if navigation switched panes mid-flush — settling that
      // one early would fire its renames without quiet period or blur.
      const session = sessionRef.current
      const coordinator = coordinatorRef.current
      // Blur is a settle point for title renames — but only after the flushed
      // save lands, so the tracker has seen the final title. (Quit-time flush
      // + settle is the open-documents service's job, not this listener's.)
      void session?.flush().then(() => coordinator?.settle())
    }
    window.addEventListener('blur', flush)
    return () => {
      window.removeEventListener('blur', flush)
    }
  }, [path])

  const onEditorChange = useCallback((markdown: string) => {
    sessionRef.current?.editorChanged(markdown)
  }, [])

  const bindEditor = useCallback((handle: NoteEditorHandle | null) => {
    editorRef.current = handle
  }, [])

  const keepMine = useCallback(() => {
    sessionRef.current?.keepMine()
  }, [])

  const loadTheirs = useCallback(() => {
    sessionRef.current?.loadTheirs()
  }, [])

  return { ...snapshot, onEditorChange, bindEditor, keepMine, loadTheirs }
}
