import { isAppError, ReflectError } from '../errors'
import { captureInboxRemove, createNoteIfAbsent, promoteCaptureScreenshot, readNote, writeNote } from '../graph/commands'
import { dailyPath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import { appendListItemUnderBacklinkedHeading, upgradeSectionHeadingBacklink, wikiLinkSafe } from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import { ensureBacklinkTarget } from './backlink-target'
import type { CaptureEnvelope } from './capture-envelope'
import { persistCaptureEnrichment } from './capture-enrichment-write'
import { captureLocalDate, type CaptureIdentity } from './capture-identity'
import { noteSource } from './capture-note'
import { appendXText, xCaptureFromSource, xCaptureFrontmatter, xCaptureIdentity, xCaptureMeta, xCaptureSource, type XCaptureMeta } from './x-capture-note'
import { xPostId } from './x-post'
import { fetchXText } from './x-syndication'

interface XCaptureInput {
  generation: number
  isStale?: (() => boolean) | undefined
  isNoteDirty?: ((path: string) => boolean) | undefined
}

interface XCapture {
  identity: CaptureIdentity
  source: string
  body: string
  title: string
  meta: XCaptureMeta
}

function canTouch(identity: CaptureIdentity, input: XCaptureInput): boolean {
  return !input.isStale?.() && !input.isNoteDirty?.(identity.notePath)
    && !input.isNoteDirty?.(dailyPath(identity.date))
}

async function readXCapture(path: string, generation: number): Promise<XCapture | null> {
  let source: string
  try {
    source = await readNote(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') return null
    throw cause
  }
  return {
    source, identity: xCaptureFromSource(path, source), meta: xCaptureMeta(source),
    body: splitFrontmatter(source).body, title: parseNote({ path, source }).title,
  }
}

async function readDaily(identity: CaptureIdentity, generation: number): Promise<string> {
  const source = await noteSource(dailyPath(identity.date), generation)
  xCaptureFrontmatter(source)
  return source
}

function checkPost(capture: XCapture, postId: string): void {
  if (xPostId(capture.meta.captureUrl) !== postId) {
    throw new ReflectError('io', `A different capture occupies ${capture.identity.notePath}.`)
  }
}

/** Save one UUID delivery and finish its Daily backlink before removing the spool. */
export async function drainXCapture(
  envelope: CaptureEnvelope,
  spoolName: string,
  postId: string,
  input: XCaptureInput,
): Promise<'saved' | 'deferred'> {
  const proposed = xCaptureIdentity(envelope.id, captureLocalDate(new Date(envelope.capturedAt)))
  let winner = await readXCapture(proposed.notePath, input.generation)
  if (winner) checkPost(winner, postId)
  let identity = winner?.identity ?? proposed
  if (!canTouch(identity, input)) return 'deferred'
  if (winner === null) {
    await readDaily(identity, input.generation)
    let screenshot: 'none' | 'saved' | 'missing' = 'none'
    if (envelope.screenshotRef) {
      try {
        await promoteCaptureScreenshot(envelope.screenshotRef, identity.assetPath, 1600, input.generation)
        screenshot = 'saved'
      } catch (cause) {
        if (!isAppError(cause) || (cause.kind !== 'notFound' && cause.kind !== 'parse')) throw cause
        screenshot = 'missing'
      }
    }
    const daily = await readDaily(identity, input.generation)
    const source = await xCaptureSource(envelope, identity, postId, screenshot, daily)
    if (!canTouch(identity, input)) return 'deferred'
    await createNoteIfAbsent(identity.notePath, source, input.generation)
  }
  const linksTitle = await ensureBacklinkTarget('Links', input.generation)
  winner = await readXCapture(identity.notePath, input.generation)
  if (!winner) throw new ReflectError('notFound', 'The saved X capture disappeared before linking.')
  checkPost(winner, postId)
  identity = winner.identity
  const path = dailyPath(identity.date)
  const source = await readDaily(identity, input.generation)
  if (!canTouch(identity, input)) return 'deferred'
  if (!parseNote({ path, source }).wikiLinks.some((link) => link.target === identity.base)) {
    const updated = appendListItemUnderBacklinkedHeading(
      upgradeSectionHeadingBacklink(source, linksTitle, ['Links']),
      linksTitle, `[[${identity.base}|${wikiLinkSafe(winner.title)}]]`, ['Links'],
    )
    if (!canTouch(identity, input)) return 'deferred'
    await writeNote(path, updated, input.generation)
  }
  if (!canTouch(identity, input)) return 'deferred'
  if (envelope.screenshotRef) await captureInboxRemove(envelope.screenshotRef, input.generation)
  await captureInboxRemove(spoolName, input.generation)
  return 'saved'
}

/** Append public text only while the original raw body and capture identity remain owned. */
export async function enrichXCapture(
  identity: CaptureIdentity,
  input: XCaptureInput,
): Promise<'enriched' | 'skipped' | 'deferred'> {
  let skipped = false
  async function current(expected?: XCapture): Promise<XCapture | null> {
    if (!canTouch(identity, input)) return null
    const snapshot = await readXCapture(identity.notePath, input.generation)
    if (!snapshot || snapshot.meta.captureStatus !== 'pending') return null
    const daily = await readDaily(snapshot.identity, input.generation)
    const hash = await hashContent(snapshot.body)
    if (!canTouch(identity, input) || !canTouch(snapshot.identity, input)) return null
    if (xCaptureFrontmatter(snapshot.source).private || xCaptureFrontmatter(daily).private
      || snapshot.identity.date !== identity.date || hash !== snapshot.meta.captureHash
      || (expected && (hash !== expected.meta.captureHash
        || snapshot.meta.captureUrl !== expected.meta.captureUrl))) {
      const latest = await readXCapture(identity.notePath, input.generation)
      if (latest?.meta.captureStatus === 'pending' && canTouch(identity, input) && canTouch(latest.identity, input)) {
        await writeNote(identity.notePath, upsertFrontmatter(latest.source, { captureStatus: 'skipped' }), input.generation)
        skipped = true
      }
      return null
    }
    return snapshot
  }
  const before = await current()
  if (before && canTouch(identity, input)) {
    const postId = xPostId(before.meta.captureUrl)
    if (postId === null) throw new ReflectError('parse', 'Invalid X capture URL.')
    const post = await fetchXText(postId)
    const snapshot = await current(before)
    if (snapshot) {
      const hash = await persistCaptureEnrichment({
        identity, expectedHash: before.meta.captureHash, expectedCapture: before.meta,
        body: appendXText(snapshot.body, post), fromTitle: snapshot.title, toTitle: snapshot.title,
        status: 'done', provider: null, generation: input.generation,
        canWrite: () => canTouch(identity, input),
      })
      if (hash !== null) return 'enriched'
    }
  }
  return skipped ? 'skipped' : 'deferred'
}
