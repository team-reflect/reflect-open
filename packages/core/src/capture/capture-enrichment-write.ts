import type { CaptureIdentity } from './capture-identity.ts'
import { sha256Hex } from '@reflect/utils'
import {
  captureNoteMeta,
  notePrivate,
  noteSource,
  retitleDailyEntry,
  type CaptureNoteMeta,
  type CaptureStatus,
} from './capture-note.ts'
import { isAppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dailyPath } from '../graph/paths.ts'
import type { ClockService } from '../ports/clock-service.ts'
import { parseNote } from '../markdown/extract.ts'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter.ts'
import type { AiProviderConfig } from '../settings/schema.ts'

/**
 * The services the capture note writes go through.
 */
export interface CaptureWriteContext {
  noteFile: NoteFileService
  clock: ClockService
}

/**
 * How long a Daily retitle waits for the capture's link to reach the Daily
 * (a sync can deliver the note before the Daily), counted from `capturedAt`.
 */
export const DAILY_LINK_WAIT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How {@link finishCaptureWrite} left a prepared retitle.
 *
 * - `committed`: the capture status is committed.
 * - `deferred`: the Daily does not link the capture yet, so the transaction
 *   stays in the note for a later pass.
 */
export type CaptureWriteFinish =
  | { kind: 'committed'; status: Exclude<CaptureStatus, 'skipped'> }
  | { kind: 'deferred'; status: Exclude<CaptureStatus, 'skipped'> }

export interface PendingCaptureSnapshot {
  /** Full source, including frontmatter, used to preserve unrelated keys. */
  source: string
  /** Markdown body whose hash guards against concurrent edits. */
  body: string
  /** Body start within `source`; the prefix is retained when replacing `body`. */
  bodyOffset: number
  /** Current note title used to keep the Daily alias in sync. */
  title: string
  /** Parsed hard privacy gate for every external enrichment call. */
  isPrivate: boolean
  /** Validated capture lifecycle and transaction frontmatter. */
  meta: CaptureNoteMeta
}

interface PersistCaptureEnrichmentInput {
  identity: CaptureIdentity
  expectedHash: string
  body: string
  fromTitle: string
  toTitle: string
  status: Exclude<CaptureStatus, 'skipped'>
  provider: AiProviderConfig | null
  screenshot?: string | undefined
  generation: number
}

/**
 * A persisted checkpoint. `deferred` means its Daily retitle still waits for
 * the capture's link, so the capture stays `pending`.
 */
export interface PersistedCapture {
  captureHash: string
  deferred: boolean
}

interface CaptureWriteTransaction {
  fromTitle: string
  status: Exclude<CaptureStatus, 'skipped'>
}

/** Read the current pending form of a capture, or `null` if it moved on. */
export async function readPendingCaptureSnapshot(
  ctx: CaptureWriteContext,
  identity: CaptureIdentity,
  generation: number,
): Promise<PendingCaptureSnapshot | null> {
  let source: string
  try {
    source = await ctx.noteFile.read(identity.notePath, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return null
    }
    throw cause
  }
  const split = splitFrontmatter(source)
  const frontmatter = parseFrontmatter(split.raw).data
  const meta = captureNoteMeta(frontmatter)
  if (meta === null || meta.captureStatus !== 'pending') {
    return null
  }
  return {
    source,
    body: split.body,
    bodyOffset: split.bodyOffset,
    title: parseNote({ path: identity.notePath, source }).title,
    isPrivate: frontmatter.private,
    meta,
  }
}

function captureWriteTransaction(meta: CaptureNoteMeta): CaptureWriteTransaction | null {
  if (meta.captureDailyFromTitle === undefined || meta.captureFinalizeStatus === undefined) {
    return null
  }
  return {
    fromTitle: meta.captureDailyFromTitle,
    status: meta.captureFinalizeStatus,
  }
}

/** Whether a prior pass left a recoverable note/Daily retitle to finish. */
export function hasCaptureWriteTransaction(meta: CaptureNoteMeta): boolean {
  return captureWriteTransaction(meta) !== null
}

function dailyLinkWaitExpired(meta: CaptureNoteMeta, now: number): boolean {
  const capturedAt = meta.capturedAt === undefined ? NaN : Date.parse(meta.capturedAt)
  return Number.isNaN(capturedAt) || now - capturedAt > DAILY_LINK_WAIT_MS
}

/**
 * Finish the Daily half of a prepared capture retitle, then commit the capture
 * status. The prepared note keeps enough state for this to resume after either
 * write fails without re-scraping or guessing whether Daily text was user-made.
 * A Daily that does not link the capture yet defers the commit until
 * {@link DAILY_LINK_WAIT_MS} has passed.
 */
export async function finishCaptureWrite(
  ctx: CaptureWriteContext,
  identity: CaptureIdentity,
  generation: number,
): Promise<CaptureWriteFinish | null> {
  let snapshot = await readPendingCaptureSnapshot(ctx, identity, generation)
  if (snapshot === null) {
    return null
  }
  const transaction = captureWriteTransaction(snapshot.meta)
  if (transaction === null) {
    return null
  }
  const expectedHash = snapshot.meta.captureHash
  const dailyNotePath = dailyPath(identity.date)
  let dailySource = await noteSource(ctx.noteFile, dailyNotePath, generation)
  if (
    snapshot.isPrivate ||
    notePrivate(dailySource) ||
    (await sha256Hex(snapshot.body)) !== expectedHash
  ) {
    return null
  }
  const retitle = retitleDailyEntry(
    dailySource,
    identity.base,
    transaction.fromTitle,
    snapshot.title,
  )
  if (retitle.kind === 'missing' && !dailyLinkWaitExpired(snapshot.meta, ctx.clock.now())) {
    return { kind: 'deferred', status: transaction.status }
  }
  if (retitle.kind === 'retitled') {
    await ctx.noteFile.write(dailyNotePath, retitle.source, generation)
  }

  snapshot = await readPendingCaptureSnapshot(ctx, identity, generation)
  dailySource = await noteSource(ctx.noteFile, dailyNotePath, generation)
  const currentTransaction = snapshot === null ? null : captureWriteTransaction(snapshot.meta)
  if (
    snapshot === null ||
    currentTransaction === null ||
    currentTransaction.fromTitle !== transaction.fromTitle ||
    currentTransaction.status !== transaction.status ||
    snapshot.isPrivate ||
    notePrivate(dailySource) ||
    (await sha256Hex(snapshot.body)) !== expectedHash
  ) {
    return null
  }
  await ctx.noteFile.write(
    identity.notePath,
    upsertFrontmatter(snapshot.source, {
      captureStatus: transaction.status,
      captureDailyFromTitle: undefined,
      captureFinalizeStatus: undefined,
    }),
    generation,
  )
  return { kind: 'committed', status: transaction.status }
}

/**
 * Persist a metadata or AI checkpoint. Title changes are prepared in the note
 * first and committed only after the Daily alias is updated, making the
 * two-file change recoverable on the next pass. A retitle still waiting for
 * its Daily link carries over: the transaction keeps the oldest `fromTitle`,
 * because that is the text the Daily link will hold when it arrives.
 */
export async function persistCaptureEnrichment(
  ctx: CaptureWriteContext,
  input: PersistCaptureEnrichmentInput,
): Promise<PersistedCapture | null> {
  const captureHash = await sha256Hex(input.body)
  const snapshot = await readPendingCaptureSnapshot(ctx, input.identity, input.generation)
  const dailySource = await noteSource(
    ctx.noteFile,
    dailyPath(input.identity.date),
    input.generation,
  )
  if (
    snapshot === null ||
    snapshot.title !== input.fromTitle ||
    snapshot.isPrivate ||
    notePrivate(dailySource) ||
    (await sha256Hex(snapshot.body)) !== input.expectedHash
  ) {
    return null
  }
  const reassembled = snapshot.source.slice(0, snapshot.bodyOffset) + input.body
  const carried = captureWriteTransaction(snapshot.meta)
  const fromTitle = carried?.fromTitle ?? input.fromTitle
  const needsDaily = carried !== null || input.toTitle !== input.fromTitle
  await ctx.noteFile.write(
    input.identity.notePath,
    upsertFrontmatter(reassembled, {
      captureStatus: needsDaily ? 'pending' : input.status,
      captureMetadataStatus: 'done',
      captureHash,
      captureProvider: input.provider?.provider,
      captureModel: input.provider?.model,
      ...(input.screenshot === undefined ? {} : { captureScreenshot: input.screenshot }),
      captureDailyFromTitle: needsDaily ? fromTitle : undefined,
      captureFinalizeStatus: needsDaily ? input.status : undefined,
    }),
    input.generation,
  )
  if (!needsDaily) {
    return { captureHash, deferred: false }
  }
  const finish = await finishCaptureWrite(ctx, input.identity, input.generation)
  if (finish === null) {
    return null
  }
  return { captureHash, deferred: finish.kind === 'deferred' }
}
