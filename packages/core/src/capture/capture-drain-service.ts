import type { MaybePromise } from '@reflect/utils'
import type { XPostEnvelope } from './bookmark-envelope.ts'
import { sha256Hex } from '@reflect/utils'
import {
  inboxEnvelopeSchema,
  type InboxEnvelope,
  type TextCaptureEnvelope,
} from './capture-envelope.ts'
import {
  captureFromPath,
  captureIdentity,
  captureLocalDate,
  captureSpoolName,
  type CaptureIdentity,
} from './capture-identity.ts'
import {
  captureNoteMeta,
  captureNoteSource,
  displayTitle,
  notePrivate,
  noteSource,
  retitleDailyEntry,
  type CaptureStatus,
} from './capture-note.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ReconcileStop } from '../reconcile/reconcile.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import type { CaptureInboxService } from '../graph/capture-inbox-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dailyPath, notePath } from '../graph/paths.ts'
import { parseNote } from '../markdown/extract.ts'
import { parseFrontmatter, splitFrontmatter } from '../markdown/frontmatter.ts'
import { headingNamesSection, sectionEnd, topLevelHeadings } from '../markdown/heading-blocks.ts'
import {
  appendListItem,
  applyTaskEdits,
  linkSectionHeading,
  type SectionTarget,
} from '../markdown/task-ast.ts'
import { createArchivedPost, type XArchiveService } from '../embeds/x-archive-service.ts'
import type { BacklinkTargetService } from './backlink-target-service.ts'

/**
 * The category note every captured-link section backlinks.
 */
const LINKS_NOTE_TITLE = 'Links'

/**
 * Long-edge cap for promoted screenshots (the Rust side re-encodes JPEG).
 */
const SCREENSHOT_MAX_DIM = 1600

/**
 * Spool `.jpg`s with no sibling `.json` older than this are host-crash debris.
 */
const ORPHAN_SPOOL_MAX_AGE_MS = 60 * 60 * 1000

export interface DrainCaptureInboxInput {
  /**
   * `GraphInfo.generation`, pins every read and write to the issuing graph.
   */
  generation: number
  /**
   * Appends an X post to the daily note at `path`, merging with a live editor when open.
   */
  writeXPost?: (envelope: XPostEnvelope, path: string) => MaybePromise<void>
  /**
   * Abort gate, checked between spool files (graph switch / unmount).
   */
  isStale?: () => boolean
}

export interface DrainCaptureInboxOutcome {
  /**
   * Spooled envelopes present when the pass started.
   */
  pending: number
  /**
   * Captures written (fresh notes plus dedup refreshes).
   */
  drained: number
  /**
   * Of `drained`, how many link captures refreshed an existing same-day
   * entry in place. Text captures never count here: duplicates are allowed
   * by design (Plan 24), so every text envelope appends.
   */
  deduped: number
  /**
   * Unparseable spool files quarantined under `.reflect/inbox-rejected/`.
   */
  invalid: number
  /**
   * Why spool files remain, or `null` when the inbox drained.
   */
  stopped: ReconcileStop | null
}

interface SameDayCapture {
  identity: CaptureIdentity
  /**
   * The existing note's display title, what the daily's link text mirrors.
   */
  title: string
}

function isXPost(envelope: InboxEnvelope): envelope is XPostEnvelope {
  return envelope.kind === 'x-bookmark' || envelope.kind === 'x-like'
}

function parseEnvelope(raw: string): InboxEnvelope | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = inboxEnvelopeSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

export interface CaptureDrainServiceDeps {
  readonly captureInbox: CaptureInboxService
  readonly noteFile: NoteFileService
  readonly xArchive: XArchiveService
  readonly backlinkTarget: BacklinkTargetService
  readonly clock: ClockService
  readonly logger: LoggerService
}

/**
 * Phase 1 of link capture: the durable raw save of every spooled envelope.
 */
export interface CaptureDrainService {
  /**
   * Drain every spooled capture into the graph. Never throws.
   */
  drain(input: DrainCaptureInboxInput): Promise<DrainCaptureInboxOutcome>
}

class CaptureDrainServiceImpl implements CaptureDrainService {
  readonly #deps: CaptureDrainServiceDeps

  constructor(deps: CaptureDrainServiceDeps) {
    this.#deps = deps
  }

  async drain(input: DrainCaptureInboxInput): Promise<DrainCaptureInboxOutcome> {
    const { captureInbox, noteFile, xArchive, backlinkTarget } = this.#deps
    let entries
    try {
      entries = await captureInbox.list(input.generation)
    } catch (cause) {
      return {
        pending: 0,
        drained: 0,
        deduped: 0,
        invalid: 0,
        stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
      }
    }
    const spools = entries
      .filter((entry) => entry.path.endsWith('.json'))
      .sort(
        (first, second) =>
          first.modifiedMs - second.modifiedMs || first.path.localeCompare(second.path),
      )

    let xPostStop: ReconcileStop | null = null
    let drained = 0
    let deduped = 0
    let invalid = 0
    const stale = (): boolean => input.isStale?.() === true
    const outcome = (stopped: ReconcileStop | null): DrainCaptureInboxOutcome => ({
      pending: spools.length,
      drained,
      deduped,
      invalid,
      stopped,
    })

    for (const spool of spools) {
      if (stale()) {
        return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
      }
      const name = captureSpoolName(spool.path)
      try {
        const raw = await captureInbox.read(name, input.generation)
        const envelope = parseEnvelope(raw)
        if (envelope === null) {
          await captureInbox.reject(name, input.generation)
          await captureInbox.reject(name.replace(/\.json$/, '.jpg'), input.generation)
          invalid += 1
          continue
        }
        if (isXPost(envelope)) {
          try {
            if (!input.writeXPost) {
              throw new Error('X post writer is unavailable; update Reflect')
            }
            if (envelope.data) {
              await xArchive.write(
                input.generation,
                createArchivedPost(envelope.data, envelope.capturedAt),
              )
            }
            const daily = dailyPath(captureLocalDate(new Date(envelope.capturedAt)))
            await input.writeXPost(envelope, daily)
            await captureInbox.remove(name, input.generation)
            drained += 1
          } catch (cause) {
            if (stale()) {
              return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
            }
            // Keep the spool; the next pass retries after the editor settles.
            xPostStop ??= { reason: toAppError(cause).kind, message: errorMessage(cause) }
          }
          continue
        }
        if (envelope.kind !== undefined) {
          await this.#drainTextCapture(envelope, input.generation)
          await captureInbox.remove(name, input.generation)
          drained += 1
          continue
        }
        const fresh = captureIdentity(new Date(envelope.capturedAt), envelope.id)
        const daily = dailyPath(fresh.date)
        const linksNoteTitle = await backlinkTarget.ensure(LINKS_NOTE_TITLE, input.generation)
        const dailySource = await noteSource(noteFile, daily, input.generation)
        const selection = envelope.selection?.trim()
        const selectionHash = selection ? await sha256Hex(selection) : undefined
        const existing = await this.#findSameDayCapture(
          dailySource,
          [linksNoteTitle, LINKS_NOTE_TITLE],
          envelope.url,
          selectionHash,
          input.generation,
        )
        const identity = existing?.identity ?? fresh
        const status: CaptureStatus = notePrivate(dailySource) ? 'skipped' : 'pending'

        let hasScreenshot = false
        if (envelope.screenshotRef) {
          try {
            await captureInbox.promoteScreenshot(
              envelope.screenshotRef,
              identity.assetPath,
              SCREENSHOT_MAX_DIM,
              input.generation,
            )
            hasScreenshot = true
          } catch (cause) {
            const kind = isAppError(cause) ? cause.kind : null
            if (kind !== 'notFound' && kind !== 'parse') {
              throw cause
            }
          }
        }

        await noteFile.write(
          identity.notePath,
          await captureNoteSource(envelope, identity, {
            hasScreenshot,
            status,
            selectionHash,
          }),
          input.generation,
        )
        const freshTitle = displayTitle(envelope)
        let updatedDaily = dailySource
        if (existing !== null) {
          // The refresh reset the note's H1 to the fresh tab title; keep the
          // daily's link text in step.
          updatedDaily = retitleDailyEntry(updatedDaily, identity.base, existing.title, freshTitle)
        }
        const section: SectionTarget = { titles: [linksNoteTitle, LINKS_NOTE_TITLE], linked: true }
        updatedDaily = linkSectionHeading(updatedDaily, section)
        if (!updatedDaily.includes(`[[${identity.base}`)) {
          updatedDaily = appendListItem(updatedDaily, {
            kind: 'bullet',
            markdown: `[[${identity.base}|${freshTitle}]]`,
            section,
          })
        }
        if (updatedDaily !== dailySource) {
          await noteFile.write(daily, updatedDaily, input.generation)
        }
        await captureInbox.remove(name, input.generation)
        if (envelope.screenshotRef) {
          await captureInbox.remove(envelope.screenshotRef, input.generation)
        }
        drained += 1
        if (existing !== null) {
          deduped += 1
        }
      } catch (cause) {
        return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
      }
    }

    try {
      await this.#sweepOrphanSpools(entries, input)
    } catch (cause) {
      return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
    }
    return outcome(xPostStop)
  }

  /**
   * The capture note this day's Links sections already hold for `url`, or `null`.
   * The scan spans each whole section, deliberately wider than where a new entry
   * would land (the section's first bullet list), so a link an older build
   * appended below the user's own prose is still recognized instead of captured
   * a second time.
   */
  async #findSameDayCapture(
    dailySource: string,
    sectionTitles: readonly string[],
    url: string,
    selectionHash: string | undefined,
    generation: number,
  ): Promise<SameDayCapture | null> {
    const { noteFile } = this.#deps
    const { headings, wikiLinks } = parseNote({ path: '', source: dailySource })
    const sectionHeadings = topLevelHeadings(headings)
    const linkSections = sectionHeadings.filter(
      (heading) => heading.level <= 2 && headingNamesSection(heading, wikiLinks, sectionTitles),
    )
    if (linkSections.length === 0) {
      return null
    }
    const ranges = linkSections.map((section) => ({
      from: section.to,
      to: sectionEnd(sectionHeadings, section, dailySource.length),
    }))
    const targets = wikiLinks
      .filter((link) => ranges.some((range) => link.from >= range.from && link.from < range.to))
      .map((link) => link.target)
    for (const target of targets) {
      const identity = captureFromPath(notePath(target))
      if (identity === null) {
        continue
      }
      let source: string
      try {
        source = await noteFile.read(identity.notePath, generation)
      } catch (cause) {
        if (isAppError(cause) && cause.kind === 'notFound') {
          continue
        }
        throw cause
      }
      const meta = captureNoteMeta(parseFrontmatter(splitFrontmatter(source).raw).data)
      if (meta && meta.captureUrl === url && meta.captureSelectionHash === selectionHash) {
        return { identity, title: parseNote({ path: identity.notePath, source }).title }
      }
    }
    return null
  }

  /**
   * Append one text capture to its capture-day daily note. Deliberately no
   * dedup: identical text captured twice is two entries (Plan 24) — the only
   * duplication risk left is a crash between this write and the spool removal,
   * which re-appends one line once on retry.
   */
  async #drainTextCapture(envelope: TextCaptureEnvelope, generation: number): Promise<void> {
    const { noteFile, logger } = this.#deps
    const daily = dailyPath(captureLocalDate(new Date(envelope.capturedAt)))
    const dailySource = await noteSource(noteFile, daily, generation)
    // `task` is Reflect's round `+` checkbox, the only marker the Tasks
    // projection reads, and lands in the `## Tasks` section; `checkbox` is the
    // square `- [ ]`, an inert daily item appended at the end.
    const next =
      envelope.kind === 'task'
        ? applyTaskEdits({ logger }, dailySource, [
            { kind: 'insert', at: { kind: 'tasksSection' }, markdown: envelope.text },
          ]).source
        : appendListItem(dailySource, {
            kind: envelope.kind === 'append' ? 'bullet' : 'checkbox',
            markdown: envelope.text,
          })
    await noteFile.write(daily, next, generation)
  }

  async #sweepOrphanSpools(
    entries: Array<{ path: string; modifiedMs: number }>,
    input: DrainCaptureInboxInput,
  ): Promise<void> {
    const { captureInbox, clock } = this.#deps
    const jsonStems = new Set(
      entries
        .filter((entry) => entry.path.endsWith('.json'))
        .map((entry) => entry.path.replace(/\.json$/, '')),
    )
    const orphans = entries.filter(
      (entry) =>
        entry.path.endsWith('.jpg') &&
        !jsonStems.has(entry.path.replace(/\.jpg$/, '')) &&
        clock.now() - entry.modifiedMs > ORPHAN_SPOOL_MAX_AGE_MS,
    )
    for (const orphan of orphans) {
      await captureInbox.remove(captureSpoolName(orphan.path), input.generation)
    }
  }
}

export function createCaptureDrainService(deps: CaptureDrainServiceDeps): CaptureDrainService {
  return new CaptureDrainServiceImpl(deps)
}
