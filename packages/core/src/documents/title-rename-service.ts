import type { ClockService } from '../ports/clock-service.ts'
import { writeGenerationFor, type GraphSessionSource } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { errorMessage } from '../errors.ts'
import { isReflectManagedNote } from '../graph/note-management.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { BacklinkService } from '../indexing/backlink-service.ts'
import type { NotePathService } from '../indexing/note-path-service.ts'
import { rewriteLinksForTitleChange, rewritePathLinksForMove } from '../indexing/rename.ts'
import type { WikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { placeOldTitleAlias } from './alias-placement.ts'
import type { NoteMoveService } from './note-move-service.ts'
import type { NoteContentOrigin } from './note-session-types.ts'
import type { OpenDocumentsService } from './open-documents-service.ts'
import { composeRenameFailure, type RenamePhaseFailures } from './rename-failure.ts'
import {
  createTitleRenameTracker,
  type TitleRename,
  type TitleRenameTracker,
} from './title-rename-tracker.ts'

/**
 * Owns one note's auto-rename lifecycle: the settled-title tracker, serialized
 * link maintenance, old-title alias placement, and the optional **file move**
 * that keeps a Reflect-managed filename a projection of the title
 * (`docs/readable-filenames.md`). Adopted and stable-path notes participate in
 * link maintenance but keep their paths.
 *
 * A settled rename can run three phases, each failing independently with an
 * honest report (see `rename-failure.ts`):
 *
 * 1. **Rewrite** inbound title targets and title-mirroring displays;
 * 2. **Alias** the old title onto this note (`alias-placement.ts`) — the
 *    safety net for links the rewrite missed;
 * 3. **Move** the file onto the new title's slug (`note-move-service.ts`).
 *
 * A *birth* (the first authored title on an untitled note) runs phase 3 alone
 * for Reflect-managed notes; other notes already have their permanent path.
 *
 * Extracted from `useNoteDocument` for the same reason the session was —
 * lifecycle coupling (pane teardown, quit, note switches) belongs to an owned
 * object, not to effect-closure flags. The rename path holds no React ref and
 * no session of its own: session liveness comes from the open-documents
 * service at placement time, and status surfaces through the global
 * operations store — a rename is app-level background work, not pane state.
 *
 * The coordinator tracks its note's **current** path: a landed move retargets
 * the live session, the open-documents registration, and this coordinator in
 * place, so a follow-up rename in the same pane session continues the alias
 * chain against the right file.
 */

export interface RenameCoordinatorOptions {
  /**
   * Graph-relative path of the (possibly renamed) note.
   */
  path: string
}

export interface RenameCoordinator {
  /**
   * Wire into the session's `onContent` stream (load/external/saved).
   */
  content(content: string, origin: NoteContentOrigin): void
  /**
   * A settle point (blur, teardown, quit): fire any pending rename now.
   */
  settle(): void
  /**
   * Resolves once settled renames' writes have landed (quit awaits this).
   */
  settled(): Promise<void>
  dispose(): void
}

/**
 * Keeps inbound links, aliases and filenames following each note's settled title.
 */
export interface TitleRenameService {
  /**
   * The auto-rename lifecycle of one open note on the open graph; the caller
   * disposes it. Each rename writes with that graph's generation as of when it
   * fires.
   */
  createCoordinator(options: RenameCoordinatorOptions): RenameCoordinator
}

export interface TitleRenameServiceDeps {
  readonly noteFile: NoteFileService
  readonly wikiResolver: WikiResolverService
  readonly backlinks: BacklinkService
  readonly notePath: NotePathService
  readonly noteMove: NoteMoveService
  readonly openDocuments: OpenDocumentsService
  readonly progress: ProgressPort
  /**
   * Runs each title tracker's quiet timer.
   */
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionSource
}

class TitleRenameServiceImpl implements TitleRenameService {
  readonly #deps: TitleRenameServiceDeps

  constructor(deps: TitleRenameServiceDeps) {
    this.#deps = deps
  }

  createCoordinator(options: RenameCoordinatorOptions): RenameCoordinator {
    return new RenameCoordinatorImpl(this.#deps, options)
  }
}

export function createTitleRenameService(deps: TitleRenameServiceDeps): TitleRenameService {
  return new TitleRenameServiceImpl(deps)
}

class RenameCoordinatorImpl implements RenameCoordinator {
  readonly #deps: TitleRenameServiceDeps
  readonly #graph: ReturnType<GraphSessionSource['getState']>['session']
  readonly #tracker: TitleRenameTracker
  /**
   * The note's current path — a landed move advances it (Plan 17).
   */
  #currentPath: string
  /**
   * Serializes rewrites — a second settle waits for the first.
   */
  #chain: Promise<void> = Promise.resolve()
  /**
   * Latest source saved or adopted by this session, used only for move ownership.
   */
  #latestSource = ''
  /**
   * Aliases the previous rename in this session added, for the next one to prune.
   */
  #autoAliases: string[] = []

  constructor(deps: TitleRenameServiceDeps, options: RenameCoordinatorOptions) {
    this.#deps = deps
    this.#graph = deps.graphSession.getState().session
    this.#currentPath = options.path
    this.#tracker = createTitleRenameTracker({
      path: options.path,
      onRename: (rename) => {
        this.#runRename(rename)
      },
      clock: deps.clock,
    })
  }

  content(content: string, origin: NoteContentOrigin): void {
    this.#latestSource = content
    if (origin === 'saved') {
      this.#tracker.saved(content)
    } else {
      this.#tracker.baseline(content) // load/external: new ground truth, no rewrite
    }
  }

  settle(): void {
    this.#tracker.settle()
  }

  settled(): Promise<void> {
    return this.#chain
  }

  dispose(): void {
    this.#tracker.dispose()
  }

  /**
   * Move the file onto its title's slug path (Plan 17). A failed move leaves
   * the filename drifting (cosmetic — resolution never reads filenames) until
   * the next settled rename re-derives it.
   */
  async #runMove(
    title: string,
    gen: number,
    options?: { rewriteInboundPathLinks?: boolean | undefined },
  ): Promise<void> {
    const { noteFile, wikiResolver, notePath, noteMove, logger } = this.#deps
    const target = await notePath.slugPathForTitle(this.#currentPath, title)
    if (target === this.#currentPath) {
      return
    }
    const from = this.#currentPath
    await noteMove.moveNote(from, target, gen)
    this.#currentPath = target
    // Retarget inbound `[[notes/…]]` path links only after the move landed: a
    // refused move then touches nothing (rollback for free), while the
    // reverse order would strand every rewritten source on a destination that
    // never materialized. The source query still works post-move — the
    // sources' own index rows keep the old target key until they reproject.
    // A per-source failure dangles that source alone, the same residue as
    // before. Births skip this: nothing can hold a path link to a placeholder
    // path that existed only inside this session.
    if (options?.rewriteInboundPathLinks === true) {
      try {
        await rewritePathLinksForMove(from, target, {
          pathLinkSources: (targetPathKey) => wikiResolver.getPathLinkSources(targetPathKey),
          read: (forPath) => noteFile.read(forPath, gen),
          write: async (forPath, contents) => {
            await noteFile.write(forPath, contents, gen)
          },
        })
      } catch (cause) {
        logger.error('path link rewrite failed:', cause)
      }
    }
  }

  // Rewrite inbound links across the graph, record the old title as an alias,
  // then move only a Reflect-managed file onto the new title's slug. Every
  // write carries the generation read at run time (stale → loud rejection in
  // Rust). A rename pending across a graph switch is dropped, never
  // cross-written.
  #runRename(rename: TitleRename): void {
    const { noteFile, wikiResolver, backlinks, openDocuments, progress, logger, graphSession } =
      this.#deps
    this.#chain = this.#chain.then(async () => {
      const gen = this.#graph === null ? null : writeGenerationFor(graphSession, this.#graph)
      if (gen === null) {
        // Unreachable in the current wiring (a rename only arms after a save,
        // which requires an open graph) — but the tracker's baseline has
        // already advanced, so if a future caller gets here the drop must be
        // loud, not silent.
        logger.error(
          `rename dropped (no graph generation): "${rename.from ?? ''}" → "${rename.to}" on ${this.#currentPath}`,
        )
        return
      }
      if (rename.from === null) {
        if (!isReflectManagedNote(this.#currentPath, this.#latestSource)) {
          return
        }
        // A birth: the first authored title on an untitled note. Nothing
        // links to a title that never existed — no rewrite, no alias — but
        // the file sheds its placeholder name for the title's slug.
        const operation = progress.start(`Naming "${rename.to}"`)
        try {
          await this.#runMove(rename.to, gen)
          operation.done()
        } catch (cause) {
          logger.error('note file move failed:', cause)
          operation.fail(
            `${errorMessage(cause)} — the note keeps its placeholder filename; the title and its links are unaffected`,
          )
        }
        return
      }
      const from = rename.from
      const operation = progress.start(`Renaming "${from}" → "${rename.to}"`)
      // The phases fail independently and the report says what held — the
      // permutations live in `composeRenameFailure`.
      const failures: RenamePhaseFailures = { rewrite: null, alias: null, move: null }
      try {
        let collision = false
        try {
          const result = await rewriteLinksForTitleChange({
            path: this.#currentPath,
            from,
            to: rename.to,
            io: {
              sources: (targetKey) => wikiResolver.getLinkSources(targetKey),
              backlinks: (forPath) => backlinks.getBacklinks(forPath),
              read: (forPath) => noteFile.read(forPath, gen),
              write: async (forPath, contents) => {
                await noteFile.write(forPath, contents, gen)
              },
              resolve: (target) => wikiResolver.resolveWikiTarget(target),
            },
            onProgress: (done, total) => {
              operation.progress(done, total)
            },
          })
          collision = result.collision
        } catch (cause) {
          // A failed rewrite must NOT skip the alias below: the tracker's
          // baseline has already advanced (re-arming would re-fire with a
          // stale `from` after further edits), so the alias is the safety
          // net that keeps every un-rewritten link resolving to this note.
          failures.rewrite = errorMessage(cause)
          logger.error('rename link rewrite failed:', cause)
        }
        // The tracker only marks a continuing chain (the title the previous
        // rename left behind); what that rename actually added is remembered
        // here, so a chained rename prunes exactly those and never an alias
        // the user authored.
        const previousAutoAliases = rename.previousAutoAlias === null ? [] : this.#autoAliases
        this.#autoAliases = []
        if (!collision) {
          try {
            this.#autoAliases = await placeOldTitleAlias(
              { noteFile, openDocuments },
              this.#currentPath,
              { from, to: rename.to, previousAutoAliases },
              gen,
            )
          } catch (cause) {
            failures.alias = errorMessage(cause)
            logger.error('rename alias placement failed:', cause)
          }
        }
        // Link maintenance applies to every editable note. Filename projection
        // is a separate capability: stable-path and adopted notes stay put.
        if (isReflectManagedNote(this.#currentPath, this.#latestSource)) {
          try {
            await this.#runMove(rename.to, gen, { rewriteInboundPathLinks: true })
          } catch (cause) {
            failures.move = errorMessage(cause)
            logger.error('note file move failed:', cause)
          }
        }
      } finally {
        const failure = composeRenameFailure(from, failures)
        if (failure !== null) {
          operation.fail(failure)
        } else {
          operation.done()
        }
      }
    })
  }
}
