import { isAppError } from '../errors'
import { readNote, writeNote } from '../graph/commands'
import { dailyPath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import type { AiProviderConfig } from '../settings/schema'
import type { CaptureIdentity } from './capture-identity'
import {
  captureNoteMeta,
  notePrivate,
  noteSource,
  retitleDailyEntry,
  type CaptureNoteMeta,
  type CaptureStatus,
} from './capture-note'

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
  expectedInput?: unknown
  expectedCaptureId?: string
  canWrite?: (() => boolean) | undefined
}

interface CaptureWriteTransaction {
  fromTitle: string
  status: Exclude<CaptureStatus, 'skipped'>
}

/** Read the current pending form of a capture, or `null` if it moved on. */
export async function readPendingCaptureSnapshot(
  identity: CaptureIdentity,
  generation: number,
): Promise<PendingCaptureSnapshot | null> {
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

/**
 * Finish the Daily half of a prepared capture retitle, then commit the capture
 * status. The prepared note keeps enough state for this to resume after either
 * write fails without re-scraping or guessing whether Daily text was user-made.
 */
export async function finishCaptureWrite(
  identity: CaptureIdentity,
  generation: number,
  canWrite: () => boolean = () => true,
): Promise<Exclude<CaptureStatus, 'skipped'> | null> {
  if (!canWrite()) return null
  let snapshot = await readPendingCaptureSnapshot(identity, generation)
  if (snapshot === null) {
    return null
  }
  const transaction = captureWriteTransaction(snapshot.meta)
  if (transaction === null) {
    return null
  }
  const expectedHash = snapshot.meta.captureHash
  const expectedInput = JSON.stringify(snapshot.meta.captureInput)
  const expectedCaptureId = snapshot.meta.captureId
  const dailyNotePath = dailyPath(identity.date)
  let dailySource = await noteSource(dailyNotePath, generation)
  if (
    !canWrite() ||
    snapshot.isPrivate ||
    notePrivate(dailySource) ||
    (await hashContent(snapshot.body)) !== expectedHash
  ) {
    return null
  }
  const retitled = retitleDailyEntry(
    dailySource,
    identity.base,
    transaction.fromTitle,
    snapshot.title,
  )
  if (retitled !== dailySource) {
    if (!canWrite()) return null
    await writeNote(dailyNotePath, retitled, generation)
  }

  snapshot = await readPendingCaptureSnapshot(identity, generation)
  dailySource = await noteSource(dailyNotePath, generation)
  const currentTransaction = snapshot === null ? null : captureWriteTransaction(snapshot.meta)
  if (
    snapshot === null ||
    currentTransaction === null ||
    currentTransaction.fromTitle !== transaction.fromTitle ||
    currentTransaction.status !== transaction.status ||
    snapshot.meta.captureId !== expectedCaptureId ||
    JSON.stringify(snapshot.meta.captureInput) !== expectedInput ||
    !canWrite() ||
    snapshot.isPrivate ||
    notePrivate(dailySource) ||
    (await hashContent(snapshot.body)) !== expectedHash
  ) {
    return null
  }
  if (!canWrite()) return null
  await writeNote(
    identity.notePath,
    upsertFrontmatter(snapshot.source, {
      captureStatus: transaction.status,
      ...(snapshot.meta.captureKind === 'x' && transaction.status === 'done'
        ? { captureInput: undefined }
        : {}),
      captureDailyFromTitle: undefined,
      captureFinalizeStatus: undefined,
    }),
    generation,
  )
  return transaction.status
}

/**
 * Persist a metadata or AI checkpoint. Title changes are prepared in the note
 * first and committed only after the Daily alias is updated, making the
 * two-file change recoverable on the next pass.
 */
export async function persistCaptureEnrichment(
  input: PersistCaptureEnrichmentInput,
): Promise<string | null> {
  const canWrite = input.canWrite ?? (() => true)
  if (!canWrite()) return null
  const captureHash = await hashContent(input.body)
  const snapshot = await readPendingCaptureSnapshot(input.identity, input.generation)
  const dailySource = await noteSource(dailyPath(input.identity.date), input.generation)
  if (
    snapshot === null ||
    snapshot.title !== input.fromTitle ||
    (input.expectedCaptureId !== undefined &&
      snapshot.meta.captureId !== input.expectedCaptureId) ||
    (input.expectedInput !== undefined &&
      JSON.stringify(snapshot.meta.captureInput) !== JSON.stringify(input.expectedInput)) ||
    !canWrite() ||
    snapshot.isPrivate ||
    notePrivate(dailySource) ||
    (await hashContent(snapshot.body)) !== input.expectedHash
  ) {
    return null
  }
  const reassembled = snapshot.source.slice(0, snapshot.bodyOffset) + input.body
  const titleChanged = input.toTitle !== input.fromTitle
  if (!canWrite()) return null
  await writeNote(
    input.identity.notePath,
    upsertFrontmatter(reassembled, {
      captureStatus: titleChanged ? 'pending' : input.status,
      ...(snapshot.meta.captureKind === 'x' && input.status === 'done' && !titleChanged
        ? { captureInput: undefined }
        : {}),
      captureMetadataStatus: 'done',
      captureHash,
      captureProvider: input.provider?.provider,
      captureModel: input.provider?.model,
      ...(input.screenshot === undefined ? {} : { captureScreenshot: input.screenshot }),
      captureDailyFromTitle: titleChanged ? input.fromTitle : undefined,
      captureFinalizeStatus: titleChanged ? input.status : undefined,
    }),
    input.generation,
  )
  if (
    titleChanged &&
    (await finishCaptureWrite(input.identity, input.generation, canWrite)) === null
  ) {
    return null
  }
  return captureHash
}
