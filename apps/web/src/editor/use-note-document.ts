import { useEffect, useState } from 'react'
import {
  createDocumentBinding,
  type DocumentBinding,
  type DocumentView,
  type RenameCoordinator,
} from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { checkRoundTrip } from '@meowdown/markdown'

/**
 * React adapter over the `@reflect/core` document state machine
 * (`NoteSessionService`): one session per open path, wired to the watcher
 * event stream (through `OpenDocumentsService`). All save/merge/protection
 * semantics live in core's `note-session-service.ts`, and the
 * create/adopt/teardown/hand-off lifecycle (a rename retargets the live
 * session and the route follows, Plan 17) lives in core's
 * `document-binding.ts` — this hook only adapts both to React.
 */

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
 * The live session of `path` with its snapshot and epoch. Key the editor on
 * the epoch, not the path: a rename retargets the session and keeps it.
 *
 * @param path graph-relative path of the open note; the session writes to the
 *   graph open when it is created, and is read-only while no graph is open.
 */
export function useNoteDocument(path: string | null, options?: NoteDocumentOptions): DocumentView {
  const createIfMissing = options?.createIfMissing ?? false
  const trackRenames = options?.trackRenames ?? false
  const missingSeed = options?.missingSeed
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
  const canWrite = useGraphInfo() !== null

  useEffect(() => {
    if (!path) {
      return
    }
    const { session, created } = binding.bind(path, {
      // The auto-rename lifecycle (Plan 07b/17) is owned by the coordinator —
      // the tracker, the rewrite chain, alias placement, and the file move.
      coordinator: () => (trackRenames ? titleRename.createCoordinator({ path }) : null),
      session: (coordinator, onSnapshot) => {
        return noteSessions.create({
          path,
          readOnly: !canWrite,
          classify: checkRoundTrip,
          onSnapshot,
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

  // Render reads the binding only through its store: a method call here would
  // be memoized on the binding and freeze at its first value.
  return useStore(binding.view)
}
