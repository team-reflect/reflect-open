import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getLinkSources,
  hasBridge,
  nextAliases,
  parseNote,
  readNote,
  resolveWikiTarget,
  rewriteLinksForTitleChange,
  subscribeFileChanges,
  upsertFrontmatter,
  writeNote,
} from '@reflect/core'
import { registerFlush } from './flush-registry'
import type { NoteEditorHandle } from './note-editor'
import { createTitleRenameTracker, type TitleRename, type TitleRenameTracker } from './title-rename'
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
  /** Live progress of a rename's link rewrite (Plan 07b), `null` when idle. */
  renameProgress: { done: number; total: number } | null
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
  const [snapshot, setSnapshot] = useState<NoteSessionSnapshot>(INITIAL_NOTE_SNAPSHOT)
  const [renameProgress, setRenameProgress] = useState<{ done: number; total: number } | null>(
    null,
  )
  const editorRef = useRef<NoteEditorHandle | null>(null)
  const sessionRef = useRef<NoteSession | null>(null)
  const trackerRef = useRef<TitleRenameTracker | null>(null)
  /** Mirrors the snapshot's conflict for non-reactive checks (rename gating). */
  const conflictRef = useRef<string | null>(null)
  /** Serializes rename rewrites — a second settle must wait for the first. */
  const renameChain = useRef<Promise<void>>(Promise.resolve())

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
    // The rename rewrite (Plan 07b): rewrite inbound links across the graph,
    // then record the old title as an alias on this note. Runs serialized;
    // every write carries the generation (stale → loud rejection). The alias
    // is bound to *this* effect's session — never the ref, which can already
    // point at a different note's session by the time the rewrite finishes —
    // and lands via its frontmatter channel while the pane is open (the
    // editor view never churns), or via a direct disk write after teardown
    // (no editor left to disturb; a reopened pane reconciles it like any
    // external change).
    let paneClosed = false
    const runRename = (rename: TitleRename): void => {
      renameChain.current = renameChain.current.then(async () => {
        const generation = generationRef.current
        if (generation === null) {
          return
        }
        try {
          await rewriteLinksForTitleChange({
            path,
            from: rename.from,
            to: rename.to,
            io: {
              sources: getLinkSources,
              read: readNote,
              write: (forPath, contents) => writeNote(forPath, contents, generation),
              resolve: resolveWikiTarget,
            },
            onProgress: (done, total) => setRenameProgress({ done, total }),
          })
          const aliases = nextAliases(
            parseNote({ path, source: rename.content }).frontmatter.aliases,
            rename,
          )
          if (aliases !== null) {
            if (!paneClosed) {
              session.updateFrontmatter({ aliases })
              // Flush rather than ride the debounce: a settle is exactly the
              // moment to persist, and quit-time teardown awaits this chain.
              await session.flush()
            } else {
              const content = await readNote(path)
              const patched = upsertFrontmatter(content, { aliases })
              if (patched !== content) {
                await writeNote(path, patched, generation)
              }
            }
          }
        } catch (cause) {
          console.error('rename link rewrite failed:', cause)
        } finally {
          setRenameProgress(null)
        }
      })
    }
    const tracker = trackRenames
      ? createTitleRenameTracker({
          path,
          onRename: runRename,
          // A parked conflict contests this very content — rewriting the graph
          // for a title the user may be about to discard ("load theirs") would
          // strand every rewritten link. Blocked renames stay pending: "keep
          // mine" saves and re-arms; "load theirs" re-baselines and clears.
          canFire: () => conflictRef.current === null,
        })
      : null
    trackerRef.current = tracker

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
      onContent: tracker
        ? (content, origin) => {
            if (origin === 'saved') {
              tracker.saved(content)
            } else {
              tracker.baseline(content) // load/external: new ground truth, no rewrite
            }
          }
        : undefined,
      createIfMissing,
    })
    sessionRef.current = session
    session.load()
    return () => {
      if (sessionRef.current === session) {
        sessionRef.current = null
      }
      if (trackerRef.current === tracker) {
        trackerRef.current = null
      }
      // Disposal flushes pending edits to the session's own path — the
      // path-switch "final flush" lives here, not in cross-note bookkeeping.
      // The flush's landed save reaches the tracker via onContent('saved');
      // settle after it so a just-edited title still renames on the way out.
      paneClosed = true // a rename firing from here writes its alias to disk
      const settled = session.flush()
      session.dispose()
      if (tracker) {
        void settled.then(() => {
          tracker.settle()
          tracker.dispose()
        })
      }
    }
  }, [path, canWrite, createIfMissing, trackRenames])

  // External-change reconciliation via the watcher (Plan 04b events).
  useEffect(() => {
    if (!path || !hasBridge()) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null
    void subscribeFileChanges((changes) => {
      if (!active || !changes.some((change) => change.path === path && change.kind === 'upsert')) {
        return
      }
      sessionRef.current?.externalChanged()
    }).then((fn) => {
      if (active) {
        unlisten = fn
      } else {
        fn()
      }
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [path])

  // Flush pending edits when the window loses focus, and register with the
  // app-global registry so quit-time teardown (window close, ⌘Q — paths where
  // unmount effects never run) can flush this buffer too. The session's flush
  // resolves once the write has landed, which is what makes quit wait.
  useEffect(() => {
    if (!path) {
      return
    }
    const flush = (): void => {
      const settled = sessionRef.current?.flush()
      // Blur is a settle point for title renames — but only after the flushed
      // save lands, so the tracker has seen the final title.
      void settled?.then(() => trackerRef.current?.settle())
    }
    const unregister = registerFlush(async () => {
      await sessionRef.current?.flush()
      // Quit teardown is a settle point too: a pending title change must
      // rewrite its links before the webview dies — settle (synchronously
      // appends the rewrite to the chain), then wait for the writes to land.
      trackerRef.current?.settle()
      await renameChain.current
    })
    window.addEventListener('blur', flush)
    return () => {
      unregister()
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

  return { ...snapshot, renameProgress, onEditorChange, bindEditor, keepMine, loadTheirs }
}
