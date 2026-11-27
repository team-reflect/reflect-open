import { isIsoDate } from '@reflect/utils'
import type { WritableNoteFileService } from '../graph/note-file-service.ts'
import { wikiNoteReference } from '../graph/note-reference.ts'
import { dailyPath, dateFromDailyPath, isTemplatePath } from '../graph/paths.ts'
import { UNCLAIMED_TIER, type WikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { parseNote } from '../markdown/extract.ts'
import type { LoggerService } from '../ports/logger-service.ts'

const DATE_LINK_HINT = /\[\[\s*\d{4}/

/**
 * Creates the empty daily note of a day that notes link to while no note
 * claims that day, so the day's backlinks resolve.
 */
export interface LinkedDayService {
  /**
   * Create the missing daily notes that `source`, the text of the note at
   * `path`, links to. Never rejects.
   */
  ensureLinkedDays(path: string, source: string, generation: number): Promise<void>
  /**
   * Create the daily note at `path` when it has no file and a note links to
   * its day. Never rejects.
   */
  ensureLinkedDay(path: string, generation: number): Promise<void>
}

export interface LinkedDayServiceDeps {
  readonly noteFile: WritableNoteFileService
  readonly wikiResolver: WikiResolverService
  readonly logger: LoggerService
}

class LinkedDayServiceImpl implements LinkedDayService {
  readonly #deps: LinkedDayServiceDeps

  constructor(deps: LinkedDayServiceDeps) {
    this.#deps = deps
  }

  async ensureLinkedDays(path: string, source: string, generation: number): Promise<void> {
    if (isTemplatePath(path) || !DATE_LINK_HINT.test(source)) {
      return
    }
    try {
      await Promise.all(
        collectLinkedDates(path, source).map((date) => this.#createUnclaimed(date, generation)),
      )
    } catch (error: unknown) {
      this.#deps.logger.error('failed to create linked daily notes:', error)
    }
  }

  async ensureLinkedDay(path: string, generation: number): Promise<void> {
    const date = dateFromDailyPath(path)
    if (date === null) {
      return
    }
    try {
      const sources = await this.#deps.wikiResolver.getLinkSources(date)
      if (sources.length > 0) {
        await this.#createUnclaimed(date, generation)
      }
    } catch (error: unknown) {
      this.#deps.logger.error('failed to create a linked daily note:', error)
    }
  }

  /**
   * Create the empty daily note of `date` when no note claims `date` as a link target.
   */
  async #createUnclaimed(date: string, generation: number): Promise<void> {
    const match = await this.#deps.wikiResolver.findWikiTargetMatch(date)
    if (match.tier === UNCLAIMED_TIER) {
      await this.#deps.noteFile.create(dailyPath(date), '', generation)
    }
  }
}

/**
 * The distinct days that the wiki links of `source` name, without the day of `path` itself.
 */
function collectLinkedDates(path: string, source: string): string[] {
  const dates = new Set<string>()
  for (const link of parseNote({ path, source }).wikiLinks) {
    const reference = wikiNoteReference(link.target)
    if (
      reference?.kind === 'key' &&
      isIsoDate(reference.key) &&
      dailyPath(reference.key) !== path
    ) {
      dates.add(reference.key)
    }
  }
  return [...dates]
}

export function createLinkedDayService(deps: LinkedDayServiceDeps): LinkedDayService {
  return new LinkedDayServiceImpl(deps)
}
