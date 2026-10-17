import type { MaybePromise } from '@reflect/utils'
import { AppError } from '../errors.ts'
import type { NoteCreationService } from '../graph/note-creation-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { wikiLinkSafe } from '../markdown/edit.ts'
import { parseNote } from '../markdown/extract.ts'

export interface BacklinkTargetServiceDeps {
  readonly noteCreation: NoteCreationService
  readonly noteFile: NoteFileService
}

/**
 * The category notes that automatic backlinks point at (`Links`, `Audio memos`).
 */
export interface BacklinkTargetService {
  /**
   * Resolve the note targeted by an automatic backlink, or create it safely.
   * Existing duplicates use the same sorted-first winner as read-only wiki-link
   * resolution. That ambiguity must not block durable capture, and no new note
   * is created in that case. An unavailable match (an iCloud placeholder or a
   * failed read) must not block capture either: the requested spelling is kept
   * unchanged and resolves once the note is readable on this device. Returns a
   * link-safe current title so renames keep one section; an unsafe title falls
   * back to the requested spelling that just resolved as its alias.
   */
  ensure(title: string, generation: number): MaybePromise<string>
}

class BacklinkTargetServiceImpl implements BacklinkTargetService {
  readonly #deps: BacklinkTargetServiceDeps

  constructor(deps: BacklinkTargetServiceDeps) {
    this.#deps = deps
  }

  async ensure(title: string, generation: number): Promise<string> {
    const { noteCreation, noteFile } = this.#deps
    const outcome = await noteCreation.resolveOrCreateNoteWithTitle(title, generation)
    if (outcome.kind === 'unavailable') {
      return title
    }
    const path = outcome.kind === 'ambiguous' ? [...outcome.paths].sort().at(0) : outcome.path
    if (path === undefined) {
      throw new AppError('unknown', `The [[${title}]] backlink target could not be resolved.`)
    }
    const source = await noteFile.read(path, generation)
    const currentTitle = parseNote({ path, source }).title
    return wikiLinkSafe(currentTitle) === currentTitle ? currentTitle : title
  }
}

export function createBacklinkTargetService(
  deps: BacklinkTargetServiceDeps,
): BacklinkTargetService {
  return new BacklinkTargetServiceImpl(deps)
}
