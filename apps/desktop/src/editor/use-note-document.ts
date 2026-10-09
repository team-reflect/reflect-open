import { useCallback, useEffect, useRef, useState } from 'react'
import { createNoteIfAbsent, mergeText, readNote, writeNote, type FileChange } from '@reflect/core'
import { startOperation } from '@/lib/operations.ts'
import { useFileChanges } from '@/lib/use-file-changes.ts'
import { createDocumentBinding, type DocumentBinding } from './document-binding.ts'
import type { NoteEditorHandle } from './note-editor.tsx'
import { createRenameCoordinator } from './rename-coordinator.ts'
import {
  createNoteSession,
  INITIAL_NOTE_SNAPSHOT,
  type ConflictCopy,
  type NoteSessionSnapshot,
} from './note-session.ts'
import { checkRoundTrip } from './roundtrip.ts'

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
   * Maintain inbound `[[links]]` when this note's settled title changes. The
   * coordinator separately requires a direct `notes/*.md` path with valid
   * Reflect ULID frontmatter before moving a file onto its title's slug, so
   * adopted and stable-path notes keep their filenames.
   */
  trackRenames?: boolean
  /**
   * Markdown to seed a missing note's buffer with (the new-note title
   * template). Requires `createIfMissing`; see `NoteSessionOptions.missingSeed`
   * for the lazy-contract semantics.
   */
  missingSeed?: string | undefined
}

/**
 * Keep edits beside a note as `<note> (conflict).md` (then `(conflict 2)`,
 * … up to the same bound as other claimed note paths) when they could not be
 * merged into an external change. Newer
 * keystrokes during one reconciliation overwrite the copy it already made,
 * checked against what was written: a copy that moved meanwhile (another
 * window, another device) is left alone and a fresh sibling is made.
 */
async function keepBesideNote(
  path: string,
  contents: string,
  previous: ConflictCopy | null,
  generation: number | null,
): Promise<string> {
  if (generation === null) {
    throw new Error('no graph generation available for the conflict copy')
  }
  if (previous !== null) {
    try {
      await writeNote(previous.path, contents, generation, previous.contents)
      return previous.path
    } catch {
      // The copy changed under us: keep it, and make a fresh one below.
    }
  }
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const [stem, ext] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  for (let n = 1; n <= 1000; n += 1) {
    const copy = `${stem} (conflict${n === 1 ? '' : ` ${n}`})${ext}`
    const outcome = await createNoteIfAbsent(copy, contents, generation)
    if (outcome.kind === 'created') {
      // Stays until dismissed: the editor has just swapped to the other
      // version, and this line is what says where the replaced text went.
      startOperation('Edits kept beside the note', { persistent: true }).warn(
        `${path} changed on disk in a way that could not be merged. Your version is at ${copy}.`,
      )
      return copy
    }
  }
  throw new Error('no free name for the conflict copy')
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
            })
          : null,
      session: (coordinator) =>
        createNoteSession({
          path,
          io: {
            read: readNote,
            write: canWrite
              ? (forPath, contents, expectedContents) => {
                  const current = generationRef.current
                  if (current === null) {
                    return Promise.reject(new Error('no graph generation available for save'))
                  }
                  return writeNote(forPath, contents, current, expectedContents)
                }
              : null,
            mergeText: canWrite ? mergeText : undefined,
            copyAside: canWrite
              ? (forPath, contents, previous) =>
                  keepBesideNote(forPath, contents, previous, generationRef.current)
              : undefined,
          },
          classify: checkRoundTrip,
          onSnapshot: (next) => {
            setSnapshot(next)
          },
          applyContent: (markdown) => editorRef.current?.setMarkdown(markdown),
          reconcilePendingEditorInput: () => {
            // Meowdown 0.43.1 synchronously emits onDocChange only when this
            // reconciliation changes the document. Discarding the always-
            // returned snapshot avoids dirtying files whose serialization is
            // merely normalized relative to their on-disk Markdown.
            editorRef.current?.getMarkdown()
          },
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
