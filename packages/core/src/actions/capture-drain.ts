import { errorMessage, isAppError, toAppError } from '../errors'
import {
  captureInboxList,
  captureInboxRead,
  captureInboxReject,
  captureInboxRemove,
  promoteCaptureScreenshot,
  readNote,
  writeNote,
} from '../graph/commands'
import { dailyPath, notePath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import {
  appendBlock,
  appendListItemUnderBacklinkedHeading,
  headingMatchesBacklinkedTitle,
  upgradeSectionHeadingBacklink,
} from '../markdown/edit'
import { sectionEnd, topLevelHeadings } from '../markdown/heading-blocks'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter } from '../markdown/frontmatter'
import type { ReconcileStop } from './audio-memo'
import { ensureBacklinkTarget } from './backlink-target'
import {
  captureFromPath,
  captureIdentity,
  captureLocalDate,
  captureSpoolName,
  type CaptureIdentity,
} from './capture-identity'
import {
  inboxEnvelopeSchema,
  type InboxEnvelope,
  type TextCaptureEnvelope,
} from './capture-envelope'
import {
  captureNoteMeta,
  captureNoteSource,
  displayTitle,
  notePrivate,
  noteSource,
  retitleDailyEntry,
  type CaptureStatus,
} from './capture-note'

/** The category note every captured-link section backlinks. */
const LINKS_NOTE_TITLE = 'Links'

/** Long-edge cap for promoted screenshots (the Rust side re-encodes JPEG). */
const SCREENSHOT_MAX_DIM = 1600

/** Spool `.jpg`s with no sibling `.json` older than this are host-crash debris. */
const ORPHAN_SPOOL_MAX_AGE_MS = 60 * 60 * 1000

export interface DrainCaptureInboxInput {
  /** `GraphInfo.generation` — pins every read and write to the issuing graph. */
  generation: number
  /** Abort gate, checked between spool files (graph switch / unmount). */
  isStale?: () => boolean
  /** Clock for the orphan sweep; injectable for tests. */
  now?: () => number
}

export interface DrainCaptureInboxOutcome {
  /** Spooled envelopes present when the pass started. */
  pending: number
  /** Captures written (fresh notes plus dedup refreshes). */
  drained: number
  /** Of `drained`, how many refreshed an existing same-day entry in place. */
  deduped: number
  /** Unparseable spool files quarantined under `.reflect/inbox-rejected/`. */
  invalid: number
  /** Why spool files remain, or `null` when the inbox drained. */
  stopped: ReconcileStop | null
}

interface SameDayCapture {
  identity: CaptureIdentity
  /** The existing note's display title — what the daily's link text mirrors. */
  title: string
}

async function findSameDayCapture(
  dailySource: string,
  sectionTitles: readonly string[],
  url: string,
  selectionHash: string | undefined,
  generation: number,
): Promise<SameDayCapture | null> {
  const { headings, wikiLinks } = parseNote({ path: '', source: dailySource })
  const sectionHeadings = topLevelHeadings(dailySource, headings)
  const linkSections = sectionHeadings.filter(
    (heading) =>
      heading.level === 2 &&
      sectionTitles.some((title) =>
        headingMatchesBacklinkedTitle(dailySource, heading, wikiLinks, title),
      ),
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
      source = await readNote(identity.notePath, generation)
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
 * Drain every spooled capture into the graph — phase 1, the durable save.
 * Never throws.
 */
export async function drainCaptureInbox(
  input: DrainCaptureInboxInput,
): Promise<DrainCaptureInboxOutcome> {
  let entries
  try {
    entries = await captureInboxList(input.generation)
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
    .sort((first, second) => first.modifiedMs - second.modifiedMs || first.path.localeCompare(second.path))

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
      const raw = await captureInboxRead(name, input.generation)
      const envelope = parseEnvelope(raw)
      if (envelope === null) {
        await captureInboxReject(name, input.generation)
        await captureInboxReject(name.replace(/\.json$/, '.jpg'), input.generation)
        invalid += 1
        continue
      }
      if ('kind' in envelope) {
        if (await drainTextCapture(envelope, input.generation)) {
          deduped += 1
        }
        await captureInboxRemove(name, input.generation)
        drained += 1
        continue
      }
      const fresh = captureIdentity(new Date(envelope.capturedAt), envelope.id)
      const daily = dailyPath(fresh.date)
      const linksNoteTitle = await ensureBacklinkTarget(LINKS_NOTE_TITLE, input.generation)
      const dailySource = await noteSource(daily, input.generation)
      const selection = envelope.selection?.trim()
      const selectionHash = selection ? await hashContent(selection) : undefined
      const existing = await findSameDayCapture(
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
          await promoteCaptureScreenshot(
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

      await writeNote(
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
      updatedDaily = upgradeSectionHeadingBacklink(updatedDaily, linksNoteTitle, [LINKS_NOTE_TITLE])
      if (!updatedDaily.includes(`[[${identity.base}`)) {
        updatedDaily = appendListItemUnderBacklinkedHeading(
          updatedDaily,
          linksNoteTitle,
          `- [[${identity.base}|${freshTitle}]]`,
          [LINKS_NOTE_TITLE],
        )
      }
      if (updatedDaily !== dailySource) {
        await writeNote(daily, updatedDaily, input.generation)
      }
      await captureInboxRemove(name, input.generation)
      if (envelope.screenshotRef) {
        await captureInboxRemove(envelope.screenshotRef, input.generation)
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
    await sweepOrphanSpools(entries, input)
  } catch (cause) {
    return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
  }
  return outcome(null)
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

async function drainTextCapture(envelope: TextCaptureEnvelope, generation: number): Promise<boolean> {
  const daily = dailyPath(captureLocalDate(new Date(envelope.capturedAt)))
  const dailySource = await noteSource(daily, generation)
  const line = envelope.kind === 'task' ? `- [ ] ${envelope.text}` : `- ${envelope.text}`
  const present = dailySource
    .split('\n')
    .some((existing) => existing.replace(/\r$/, '') === line)
  if (present) {
    return true
  }
  await writeNote(daily, appendBlock(dailySource, line), generation)
  return false
}

async function sweepOrphanSpools(
  entries: Array<{ path: string; modifiedMs: number }>,
  input: DrainCaptureInboxInput,
): Promise<void> {
  const now = input.now ?? Date.now
  const jsonStems = new Set(
    entries
      .filter((entry) => entry.path.endsWith('.json'))
      .map((entry) => entry.path.replace(/\.json$/, '')),
  )
  const orphans = entries.filter(
    (entry) =>
      entry.path.endsWith('.jpg') &&
      !jsonStems.has(entry.path.replace(/\.jpg$/, '')) &&
      now() - entry.modifiedMs > ORPHAN_SPOOL_MAX_AGE_MS,
  )
  for (const orphan of orphans) {
    await captureInboxRemove(captureSpoolName(orphan.path), input.generation)
  }
}
