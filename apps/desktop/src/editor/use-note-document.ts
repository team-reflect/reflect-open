import { useCallback, useEffect, useRef, useState } from 'react'
import { readNote, writeNote, type FileChange } from '@reflect/core'
import { useFileChanges } from '@/lib/use-file-changes'
import { createDocumentBinding, type DocumentBinding } from './document-binding'
import type { NoteEditorHandle } from './note-editor'
import { createRenameCoordinator } from './rename-coordinator'
import {
  createNoteSession,
  INITIAL_NOTE_SNAPSHOT,
  type NoteSessionSnapshot,
} from './note-session'
import { checkRoundTrip } from './roundtrip'

/**
 * React adapter over the {@link createNoteSession} document state machine: one
 * session per open `(path, generation)`, wired to the `@reflect/core` file
 * commands, the watcher event stream, and the editor's imperative handle. All
 * save/conflict/protection semantics live in `note-session.ts`, and the
 * create/adopt/teardown/hand-off lifecycle (a rename retargets the live
 * session and the route follows, Plan 17) lives in `document-binding.ts` —
 * this hook only adapts both to React.
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
  createIfMissing?: boolean
  /**
   * Auto-rewrite inbound `[[links]]` (and move the file onto its title's slug,
   * Plan 17) when this note's settled title changes. Off for daily notes —
   * their date labels are stream chrome, not content.
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
  /** Mirrors the snapshot's conflict for non-reactive checks (rename gating). */
  const conflictRef = useRef<string | null>(null)
  /** The pane's lifecycle policy object — one per hook instance. */
  const [binding] = useState<DocumentBinding>(() => createDocumentBinding())

  // Writes read the generation at write time, not at session creation, so the
  // session must NOT be keyed on `generation`: reopening the *same* graph bumps
  // it without remounting the pane, and recreating the session would dispose-
  // flush with a stale generation (rejected by Rust) and silently reload the
  // buffer from disk — losing unsaved edits. Cross-graph safety is preserved
  // because a real graph switch remounts the whole workspace (keyed by root):
  // the unmounted pane never re-renders, its ref keeps the old generation, and
  // Rust rejects its final flush instead of landing it in the new graph.
  const generationRef = useRef(generation)
  // Written during render, not in an effect: a debounced save or rename reads
  // this at write time, and reopening the *same* graph bumps the generation
  // without remounting the pane — an effect-based update would lag and let a
  // write land with the previous generation, which Rust rejects.
  // eslint-disable-next-line react-hooks/refs
  generationRef.current = generation
  const canWrite = generation !== null

  useEffect(() => {
    if (!path) {
      return
    }
    const { session, created } = binding.bind(path, {
      // The auto-rename lifecycle (Plan 07b/17) is owned by the coordinator —
      // the tracker, the rewrite chain, alias placement, and the file move.
      coordinator: () =>
        trackRenames
          ? createRenameCoordinator({
              path,
              generation: () => generationRef.current,
              canFire: () => conflictRef.current === null,
            })
          : null,
      session: (coordinator) =>
        createNoteSession({
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
          onSnapshot: (next) => {
            conflictRef.current = next.conflict
            setSnapshot(next)
          },
          applyContent: (markdown) => editorRef.current?.setMarkdown(markdown),
          onContent: coordinator ? coordinator.content : undefined,
          createIfMissing,
          missingSeed,
        }),
    })
    if (created) {
      session.load()
    }
    return () => binding.unbind(path)
  }, [binding, path, canWrite, createIfMissing, trackRenames, missingSeed])

  // External-change reconciliation via the watcher (Plan 04b events). The
  // comparison reads the session's CURRENT path, not the route prop: a rename
  // retargets the session before React re-renders the pane (Plan 17), and an
  // external change landing at the new path inside that window must still
  // reconcile — matching the prop would leave the editor stale against disk.
  const onFileChanges = useCallback(
    (changes: FileChange[]) => {
      const session = binding.session()
      if (session === null) {
        return
      }
      if (changes.some((change) => change.path === session.path && change.kind === 'upsert')) {
        session.externalChanged()
      }
    },
    [binding],
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
    editorRef.current = handle
  }, [])

  const keepMine = useCallback(() => {
    binding.session()?.keepMine()
  }, [binding])

  const loadTheirs = useCallback(() => {
    binding.session()?.loadTheirs()
  }, [binding])

  return {
    ...snapshot,
    onEditorChange,
    bindEditor,
    keepMine,
    loadTheirs,
    sessionEpoch: binding.epoch(),
  }
}
