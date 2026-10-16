import { captureFromPath, captureLocalDate, type CaptureIdentity } from './capture-identity.ts'
import { captureNoteMeta, displayTitle, noteSource } from './capture-note.ts'
import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import { isAppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dailyPath } from '../graph/paths.ts'
import { isWikiLinkSafeText } from '../indexing/suggest.ts'
import { parseNote } from '../markdown/extract.ts'
import type { ClockService } from '../ports/clock-service.ts'
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
export function repairCaptureLinks(
  source: string,
  repairs: ReadonlyMap<string, CaptureLinkRepair>,
): string {
  const mentioned = [...repairs].some(([base, { placeholder }]) =>
    source.includes(`[[${base}|${placeholder}`),
  )
  if (!mentioned) {
    return source
  }
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
 * `null` when the capture does not qualify. Pending captures are left to
 * enrichment. Skipped captures are left alone, and so are private ones, so a
 * private note's title never spreads into another note.
 */
function findCaptureRepair(source: string, identity: CaptureIdentity): CaptureLinkRepair | null {
  const { frontmatter, title } = parseNote({ path: identity.notePath, source })
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
  if (title === placeholder || !isWikiLinkSafeText(title)) {
    return null
  }
  return { placeholder, title }
}

/**
 * How far back the sweep looks. Sync races happen soon after a capture, and
 * the bound keeps the per-pass cost independent of the graph's history.
 */
export const CAPTURE_LINK_REPAIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export interface CaptureLinkRepairServiceDeps {
  readonly noteFile: NoteFileService
  readonly openDocuments: OpenDocumentsService
  readonly clock: ClockService
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
   * Repair the placeholder links of captures from the last
   * {@link CAPTURE_LINK_REPAIR_WINDOW_MS} in their Daily notes. Never throws.
   */
  sweep(generation: number): Promise<void>
}

class CaptureLinkRepairServiceImpl implements CaptureLinkRepairService {
  readonly #deps: CaptureLinkRepairServiceDeps

  constructor(deps: CaptureLinkRepairServiceDeps) {
    this.#deps = deps
  }

  async sweep(generation: number): Promise<void> {
    const { logger } = this.#deps
    let repairsByDailyPath: Map<string, Map<string, CaptureLinkRepair>>
    try {
      repairsByDailyPath = await this.#collectRecentRepairs(generation)
    } catch (cause) {
      logger.warn('capture link repair sweep failed:', cause)
      return
    }
    for (const [path, repairs] of repairsByDailyPath) {
      try {
        await this.#repairDaily(path, repairs, generation)
      } catch (cause) {
        logger.warn(`capture link repair failed for ${path}:`, cause)
      }
    }
  }

  /**
   * Repairs for recent finished captures, grouped by the Daily that links them.
   */
  async #collectRecentRepairs(
    generation: number,
  ): Promise<Map<string, Map<string, CaptureLinkRepair>>> {
    const { noteFile, clock } = this.#deps
    const cutoff = captureLocalDate(new Date(clock.now() - CAPTURE_LINK_REPAIR_WINDOW_MS))
    const repairsByDailyPath = new Map<string, Map<string, CaptureLinkRepair>>()
    for (const file of await noteFile.listNotes(generation)) {
      const identity = captureFromPath(file.path)
      // ISO dates compare in calendar order as strings.
      if (identity === null || identity.date < cutoff) {
        continue
      }
      const source = await this.#readCapture(identity, generation)
      const repair = source === null ? null : findCaptureRepair(source, identity)
      if (repair === null) {
        continue
      }
      const path = dailyPath(identity.date)
      const repairs = repairsByDailyPath.get(path) ?? new Map<string, CaptureLinkRepair>()
      repairs.set(identity.base, repair)
      repairsByDailyPath.set(path, repairs)
    }
    return repairsByDailyPath
  }

  async #repairDaily(
    path: string,
    repairs: ReadonlyMap<string, CaptureLinkRepair>,
    generation: number,
  ): Promise<void> {
    const { noteFile, openDocuments } = this.#deps
    const source = await noteSource(noteFile, path, generation)
    if (source === '') {
      return
    }
    const next = repairCaptureLinks(source, repairs)
    if (next === source) {
      return
    }
    const session = openDocuments.sessionFor(path)
    if (session !== null) {
      // Edit the live buffer so unsaved typing survives; a busy session retries next pass.
      await session.commitSourceEdit((current) =>
        current === source ? next : repairCaptureLinks(current, repairs),
      )
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
