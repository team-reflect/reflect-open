import { captureFromPath, type CaptureIdentity } from './capture-identity.ts'
import { captureNoteMeta, displayTitle, notePrivate, noteSource } from './capture-note.ts'
import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import { isAppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dailyPath, notePath } from '../graph/paths.ts'
import { isWikiLinkSafeText } from '../indexing/suggest.ts'
import { parseNote } from '../markdown/extract.ts'
import { parseFrontmatter, splitFrontmatter } from '../markdown/frontmatter.ts'
import type { LoggerService } from '../ports/logger-service.ts'

/**
 * One capture whose Daily link text is still the drain's placeholder.
 */
export interface CaptureLinkRepair {
  /**
   * The link text the drain wrote before any title was known (the URL host).
   */
  placeholder: string
  /**
   * The capture note's current title.
   */
  title: string
}

/**
 * Rewrite every wiki link `[[base|placeholder]]` to `[[base|title]]`, keyed by
 * capture base. Text that only looks like a link (code) stays as it is.
 */
export function withRepairedCaptureLinks(
  source: string,
  repairs: ReadonlyMap<string, CaptureLinkRepair>,
): string {
  let next = source
  const links = parseNote({ path: '', source }).wikiLinks
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i]!
    const repair = repairs.get(link.target)
    if (repair !== undefined && link.alias === repair.placeholder) {
      next = `${next.slice(0, link.from)}[[${link.target}|${repair.title}]]${next.slice(link.to)}`
    }
  }
  return next
}

/**
 * The repair for a finished capture whose title replaced its placeholder, or
 * `null` when the capture does not qualify. Pending captures and private
 * notes are left to enrichment; skipped captures are left alone.
 */
function captureRepair(source: string, identity: CaptureIdentity): CaptureLinkRepair | null {
  const frontmatter = parseFrontmatter(splitFrontmatter(source).raw).data
  const meta = captureNoteMeta(frontmatter)
  if (
    meta === null ||
    meta.captureStatus !== 'done' ||
    meta.captureDailyFromTitle !== undefined ||
    frontmatter.private
  ) {
    return null
  }
  const placeholder = displayTitle({ title: '', url: meta.captureUrl })
  const title = parseNote({ path: identity.notePath, source }).title
  if (title === placeholder || !isWikiLinkSafeText(title)) {
    return null
  }
  return { placeholder, title }
}

export interface CaptureLinkRepairServiceDeps {
  readonly noteFile: NoteFileService
  readonly openDocuments: OpenDocumentsService
  readonly logger: LoggerService
}

/**
 * Keeps Daily link text in step with finished captures. The enrichment
 * retitle updates the Daily only when the link is there; a sync that delivers
 * an older Daily afterwards brings back the placeholder text. This rewrites
 * such placeholders to the capture note's title.
 */
export interface CaptureLinkRepairService {
  /**
   * Repair the placeholder capture links in each Daily. Never throws.
   */
  repair(dailyPaths: readonly string[], generation: number): Promise<void>
  /**
   * The Dailies of finished captures that have a title other than their placeholder.
   */
  candidateDailies(generation: number): Promise<string[]>
}

class CaptureLinkRepairServiceImpl implements CaptureLinkRepairService {
  readonly #deps: CaptureLinkRepairServiceDeps

  constructor(deps: CaptureLinkRepairServiceDeps) {
    this.#deps = deps
  }

  async repair(dailyPaths: readonly string[], generation: number): Promise<void> {
    for (const path of dailyPaths) {
      try {
        await this.#repairDaily(path, generation)
      } catch (cause) {
        this.#deps.logger.warn(`capture link repair failed for ${path}:`, cause)
      }
    }
  }

  async candidateDailies(generation: number): Promise<string[]> {
    const { noteFile } = this.#deps
    const dailies = new Set<string>()
    for (const file of await noteFile.listNotes(generation)) {
      const identity = captureFromPath(file.path)
      if (identity === null || dailies.has(dailyPath(identity.date))) {
        continue
      }
      const source = await this.#readCapture(identity, generation)
      if (source !== null && captureRepair(source, identity) !== null) {
        dailies.add(dailyPath(identity.date))
      }
    }
    return [...dailies]
  }

  async #repairDaily(path: string, generation: number): Promise<void> {
    const { noteFile, openDocuments } = this.#deps
    const source = await noteSource(noteFile, path, generation)
    if (source === '' || notePrivate(source)) {
      return
    }
    const repairs = new Map<string, CaptureLinkRepair>()
    for (const link of parseNote({ path, source }).wikiLinks) {
      const identity = captureFromPath(notePath(link.target))
      if (identity === null || link.alias === undefined || repairs.has(identity.base)) {
        continue
      }
      const captureSource = await this.#readCapture(identity, generation)
      const repair = captureSource === null ? null : captureRepair(captureSource, identity)
      if (repair !== null && link.alias === repair.placeholder) {
        repairs.set(identity.base, repair)
      }
    }
    if (repairs.size === 0) {
      return
    }
    const next = withRepairedCaptureLinks(source, repairs)
    if (next === source) {
      return
    }
    const session = openDocuments.sessionFor(path)
    if (session !== null) {
      // Edit the live buffer so unsaved typing survives; a busy session retries later.
      await session.commitSourceEdit((current) => withRepairedCaptureLinks(current, repairs))
      return
    }
    await noteFile.write(path, next, generation, source)
  }

  async #readCapture(identity: CaptureIdentity, generation: number): Promise<string | null> {
    try {
      return await this.#deps.noteFile.read(identity.notePath, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return null
      }
      throw cause
    }
  }
}

export function createCaptureLinkRepairService(
  deps: CaptureLinkRepairServiceDeps,
): CaptureLinkRepairService {
  return new CaptureLinkRepairServiceImpl(deps)
}
