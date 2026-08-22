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
  appendListItem,
  appendListItemUnderBacklinkedHeading,
  headingMatchesBacklinkedTitle,
  upgradeSectionHeadingBacklink,
  type ListItemKind,
} from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { sectionEnd, topLevelHeadings } from '../markdown/heading-blocks'
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
  type CaptureEnvelope,
  type InboxEnvelope,
  type TextCaptureEnvelope,
} from './capture-envelope'
import {
  captureDescriptionFromBody,
  captureNoteMeta,
  captureNoteSource,
  capturePageTextFromBody,
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
  /** Captures consumed (fresh notes plus handled same-day duplicates). */
  drained: number
  /**
   * Of `drained`, how many link captures matched an existing same-day entry.
   * A match normally refreshes in place; if the note was edited or made
   * private, the duplicate is discarded instead. Text captures never count
   * here: duplicates are allowed by design (Plan 24), so every text envelope
   * appends.
   */
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
  /** Existing managed fields survive a later link-only envelope in the same batch. */
  body: string
  /** Structured summary backing the managed Summary body section. */
  summary?: string | undefined
  /** Full source used to preserve unrelated frontmatter during a safe refresh. */
  source: string
  /** Whether a refresh can replace the managed body without losing user data. */
  refreshable: boolean
}

async function readSameDayCapture(
  identity: CaptureIdentity,
  url: string,
  selectionHash: string | undefined,
  generation: number,
): Promise<SameDayCapture | null> {
  let source: string
  try {
    source = await readNote(identity.notePath, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return null
    }
    throw cause
  }
  const split = splitFrontmatter(source)
  const frontmatter = parseFrontmatter(split.raw).data
  const meta = captureNoteMeta(frontmatter)
  if (meta === null || meta.captureUrl !== url || meta.captureSelectionHash !== selectionHash) {
    return null
  }
  return {
    identity,
    title: parseNote({ path: identity.notePath, source }).title,
    body: split.body,
    summary: meta.captureSummary,
    source,
    refreshable: !frontmatter.private && (await hashContent(split.body)) === meta.captureHash,
  }
}

/**
 * The capture note this day's Links sections already hold for `url`, or `null`.
 * The scan spans each whole section, deliberately wider than where a new entry
 * would land (the section's first bullet list), so a link an older build
 * appended below the user's own prose is still recognized instead of captured
 * a second time.
 */
async function findSameDayCapture(
  dailySource: string,
  sectionTitles: readonly string[],
  url: string,
  selectionHash: string | undefined,
  generation: number,
): Promise<SameDayCapture | null> {
  const { headings, wikiLinks } = parseNote({ path: '', source: dailySource })
  const sectionHeadings = topLevelHeadings(headings)
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
    const capture = await readSameDayCapture(identity, url, selectionHash, generation)
    if (capture !== null) {
      return capture
    }
  }
  return null
}

async function removeCaptureSpool(
  name: string,
  envelope: CaptureEnvelope,
  generation: number,
): Promise<void> {
  await captureInboxRemove(name, generation)
  if (envelope.screenshotRef) {
    await captureInboxRemove(envelope.screenshotRef, generation)
  }
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
    .sort(
      (first, second) =>
        first.modifiedMs - second.modifiedMs || first.path.localeCompare(second.path),
    )

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
        await drainTextCapture(envelope, input.generation)
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
      let existing = await findSameDayCapture(
        dailySource,
        [linksNoteTitle, LINKS_NOTE_TITLE],
        envelope.url,
        selectionHash,
        input.generation,
      )
      const identity = existing?.identity ?? fresh
      const status: CaptureStatus = notePrivate(dailySource) ? 'skipped' : 'pending'

      if (existing !== null && !existing.refreshable) {
        await removeCaptureSpool(name, envelope, input.generation)
        drained += 1
        deduped += 1
        continue
      }

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

      if (existing !== null) {
        existing = await readSameDayCapture(
          existing.identity,
          envelope.url,
          selectionHash,
          input.generation,
        )
        if (existing === null || !existing.refreshable) {
          await removeCaptureSpool(name, envelope, input.generation)
          drained += 1
          deduped += 1
          continue
        }
      }
      const mergedEnvelope = existing
        ? {
            ...envelope,
            contentText: envelope.contentText ?? capturePageTextFromBody(existing.body),
            summary: envelope.summary ?? existing.summary,
            metaDescription: envelope.metaDescription ?? captureDescriptionFromBody(existing.body),
          }
        : envelope

      await writeNote(
        identity.notePath,
        await captureNoteSource(mergedEnvelope, identity, {
          hasScreenshot,
          status,
          selectionHash,
          existingSource: existing?.source,
        }),
        input.generation,
      )
      const freshTitle = displayTitle(mergedEnvelope)
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
          `[[${identity.base}|${freshTitle}]]`,
          [LINKS_NOTE_TITLE],
        )
      }
      if (updatedDaily !== dailySource) {
        await writeNote(daily, updatedDaily, input.generation)
      }
      await removeCaptureSpool(name, envelope, input.generation)
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

/**
 * Append one text capture to its capture-day daily note. Deliberately no
 * dedup: identical text captured twice is two entries (Plan 24) — the only
 * duplication risk left is a crash between this write and the spool removal,
 * which re-appends one line once on retry.
 */
async function drainTextCapture(envelope: TextCaptureEnvelope, generation: number): Promise<void> {
  const daily = dailyPath(captureLocalDate(new Date(envelope.capturedAt)))
  const dailySource = await noteSource(daily, generation)
  // `task` is Reflect's round `+` checkbox, the only marker the Tasks
  // projection reads; `checkbox` is the square `- [ ]`, an inert daily item.
  const kind: ListItemKind = envelope.kind === 'append' ? 'bullet' : envelope.kind
  await writeNote(daily, appendListItem(dailySource, envelope.text, kind), generation)
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
