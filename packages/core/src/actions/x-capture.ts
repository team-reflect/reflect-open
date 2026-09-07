import { z } from 'zod'
import { isAppError, ReflectError } from '../errors'
import {
  captureInboxRemove,
  createNoteIfAbsent,
  promoteCaptureScreenshot,
  readNote,
  writeNote,
} from '../graph/commands'
import { assetPath, dailyPath, notePath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import {
  appendListItemUnderBacklinkedHeading,
  upgradeSectionHeadingBacklink,
} from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import { ensureBacklinkTarget } from './backlink-target'
import { xPostSchema, type XEnvelope } from './capture-envelope'
import type { DrainCaptureInboxInput } from './capture-drain'
import type { CaptureIdentity } from './capture-identity'
import { captureNoteMeta, notePrivate, noteSource } from './capture-note'
import { xPostId, xPostUrl } from './x-post'
import { renderXPostNote } from './x-post-note'

export const xCaptureInputSchema = z.object({
  version: z.literal(1),
  post: xPostSchema,
  note: z.string().optional(),
  selection: z.string().optional(),
  screenshot: z
    .string()
    .regex(/^assets\/capture-[0-9a-f-]{36}\.jpg$/)
    .optional(),
})

export type XCaptureInput = z.infer<typeof xCaptureInputSchema>

/** Automatic captures share a day/post path; manual saves use the whole UUID. */
export function xCaptureIdentity(envelope: XEnvelope): CaptureIdentity {
  const { day, post, trigger } = envelope.x
  const suffix = trigger === 'manual' ? `manual-${envelope.id.toLowerCase()}` : post.id
  const base = `capture-x-${day}-${suffix}`
  return { base, date: day, notePath: notePath(base) }
}

/** Create without replacement, repair the Daily link, and only then remove the spool. */
export async function drainXCapture(
  envelope: XEnvelope,
  spoolName: string,
  options: DrainCaptureInboxInput,
): Promise<'created' | 'existing' | 'deferred'> {
  const { generation } = options
  const identity = xCaptureIdentity(envelope)
  const daily = dailyPath(identity.date)
  const deferred = (): boolean =>
    options.isStale?.() === true ||
    options.isNoteDirty?.(identity.notePath) === true ||
    options.isNoteDirty?.(daily) === true
  if (deferred()) return 'deferred'
  let winner: string | undefined
  try {
    winner = await readNote(identity.notePath, generation)
  } catch (cause) {
    if (!isAppError(cause) || cause.kind !== 'notFound') throw cause
  }
  let created = false
  if (winner === undefined) {
    const input: XCaptureInput = {
      version: 1,
      post: envelope.x.post,
      ...(envelope.note ? { note: envelope.note } : {}),
      ...(envelope.selection ? { selection: envelope.selection } : {}),
    }
    if (envelope.screenshotRef) {
      const screenshot = assetPath(`capture-${envelope.id.toLowerCase()}.jpg`)
      try {
        await promoteCaptureScreenshot(envelope.screenshotRef, screenshot, 1600, generation)
        input.screenshot = screenshot
      } catch (cause) {
        if (!isAppError(cause) || !['notFound', 'parse'].includes(cause.kind)) throw cause
      }
    }
    const body = renderXPostNote(input)
    const captureHash = await hashContent(body)
    const dailySource = await noteSource(daily, generation)
    if (deferred()) return 'deferred'
    const isPrivate = notePrivate(dailySource)
    const source = upsertFrontmatter(body, {
      aliases: [identity.base],
      private: isPrivate || undefined,
      captureKind: 'x',
      captureId: envelope.id.toLowerCase(),
      captureUrl: xPostUrl(input.post.id),
      capturedAt: envelope.capturedAt,
      captureSource: envelope.source,
      captureStatus: isPrivate ? 'skipped' : 'pending',
      captureHash,
      captureInput: isPrivate ? undefined : input,
    })
    const outcome = await createNoteIfAbsent(identity.notePath, source, generation)
    created = outcome.kind === 'created'
    winner = created ? source : await readNote(identity.notePath, generation)
  }
  const meta = captureNoteMeta(parseFrontmatter(splitFrontmatter(winner).raw).data)
  if (
    meta?.captureKind !== 'x' ||
    !meta.captureId ||
    xPostId(meta.captureUrl) !== envelope.x.post.id ||
    (envelope.x.trigger === 'manual' && meta.captureId.toLowerCase() !== envelope.id.toLowerCase())
  ) {
    throw new ReflectError('io', `Capture path is occupied by another note: ${identity.notePath}`)
  }
  if (deferred()) return 'deferred'
  const linksTitle = await ensureBacklinkTarget('Links', generation)
  const dailySource = await noteSource(daily, generation)
  const parsedDaily = parseNote({ path: daily, source: dailySource })
  if (!parsedDaily.wikiLinks.some((link) => link.target === identity.base)) {
    const title = parseNote({ path: identity.notePath, source: winner }).title
    const updated = appendListItemUnderBacklinkedHeading(
      upgradeSectionHeadingBacklink(dailySource, linksTitle, ['Links']),
      linksTitle,
      `[[${identity.base}|${title}]]`,
      ['Links'],
    )
    if (deferred()) return 'deferred'
    await writeNote(daily, updated, generation)
  }
  if (deferred()) return 'deferred'
  if (envelope.screenshotRef) await captureInboxRemove(envelope.screenshotRef, generation)
  await captureInboxRemove(spoolName, generation)
  return created ? 'created' : 'existing'
}
