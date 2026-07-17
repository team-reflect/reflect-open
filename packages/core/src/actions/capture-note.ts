import { z } from 'zod'
import { isAppError } from '../errors'
import { readNote } from '../graph/commands'
import { hashContent } from '../indexing/hash'
import { wikiLinkSafe } from '../markdown/edit'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import type { Frontmatter } from '../markdown/model'
import type { CaptureIdentity } from './capture-identity'
import type { CaptureEnvelope } from './capture-envelope'

/**
 * Enrichment lifecycle of a capture note, in its frontmatter. `skipped` means
 * enrichment stopped touching the note — an edit, a privacy flip, or a
 * deletion race won. Any checkpoint persisted before the skip, including AI
 * content and its `captureProvider`/`captureModel` provenance, stays exactly
 * as written: the stamps describe who authored the persisted text, not
 * whether the capture finished.
 */
export type CaptureStatus = 'pending' | 'done' | 'skipped'

const captureNoteMetaSchema = z.object({
  captureUrl: z.string(),
  captureStatus: z.enum(['pending', 'done', 'skipped']),
  /** The metadata attempt completed, including a permanently unsuitable page. */
  captureMetadataStatus: z.literal('done').optional(),
  /** Prior Daily alias; paired with `captureFinalizeStatus` during a retitle. */
  captureDailyFromTitle: z.string().optional(),
  /** Status to commit after the paired Daily alias update succeeds. */
  captureFinalizeStatus: z.enum(['pending', 'done']).optional(),
  captureHash: z.string(),
  captureSelectionHash: z.string().optional(),
  captureScreenshot: z.string().optional(),
})

export type CaptureNoteMeta = z.infer<typeof captureNoteMetaSchema>

/** The capture keys from a parsed frontmatter, or `null` when absent/mangled. */
export function captureNoteMeta(frontmatter: Frontmatter): CaptureNoteMeta | null {
  const parsed = captureNoteMetaSchema.safeParse(frontmatter)
  return parsed.success ? parsed.data : null
}

function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const PAGE_TEXT_START = '<!-- reflect-capture-page-text:start -->'
const PAGE_TEXT_END = '<!-- reflect-capture-page-text:end -->'

/** The capture's display title: the page title, else the URL's host. */
export function displayTitle(envelope: Pick<CaptureEnvelope, 'title' | 'url'>): string {
  const title = wikiLinkSafe(envelope.title)
  return title !== '' ? title : urlHost(envelope.url)
}

function captureNoteBody(
  envelope: CaptureEnvelope,
  identity: CaptureIdentity,
  hasScreenshot: boolean,
): string {
  const title = displayTitle(envelope)
  const metadata = [`- URL: ${envelope.url}`, '- Type: #link']
  const metaDescription = envelope.metaDescription?.trim()
  if (metaDescription) {
    metadata.push(`- Description: ${metadataValue(metaDescription)}`)
  }
  const parts = [`# ${title}`, metadata.join('\n')]
  const note = envelope.note?.trim()
  if (note) {
    parts.push(`## Note\n\n${note}`)
  }
  const selection = envelope.selection?.trim()
  if (selection) {
    parts.push(`## Selection\n\n${selection}`)
  }
  const contentText = envelope.contentText?.trim()
  if (contentText) {
    parts.push(`## Page Text\n\n${PAGE_TEXT_START}\n${contentText}\n${PAGE_TEXT_END}`)
  }
  if (hasScreenshot) {
    parts.push(`## Screenshot\n\n![${title}](${identity.assetPath})`)
  }
  return `${parts.join('\n\n')}\n`
}

export function capturePageTextFromBody(body: string): string | undefined {
  const marker = `\n## Page Text\n\n${PAGE_TEXT_START}\n`
  const markerAt = body.indexOf(marker)
  if (markerAt === -1) {
    return undefined
  }
  const contentStart = markerAt + marker.length
  const endAt = body.indexOf(PAGE_TEXT_END, contentStart)
  if (endAt === -1) {
    throw new Error('capture note is missing page text end marker')
  }
  const content = body.slice(contentStart, endAt).trim()
  return content === '' ? undefined : content
}

function firstSectionStart(body: string): number {
  let offset = 0
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      return offset
    }
    offset += line.length + 1
  }
  return body.length
}

export async function captureNoteSource(
  envelope: CaptureEnvelope,
  identity: CaptureIdentity,
  options: { hasScreenshot: boolean; status: CaptureStatus; selectionHash?: string | undefined },
): Promise<string> {
  const body = captureNoteBody(envelope, identity, options.hasScreenshot)
  return upsertFrontmatter(body, {
    aliases: [identity.base],
    captureUrl: envelope.url,
    capturedAt: envelope.capturedAt,
    captureSource: envelope.source,
    captureStatus: options.status,
    captureHash: await hashContent(body),
    captureSelectionHash: options.selectionHash,
    captureScreenshot: options.hasScreenshot ? identity.assetPath : undefined,
  })
}

/** A note's source at `generation`, where "no note yet" reads as empty. */
export async function noteSource(path: string, generation: number): Promise<string> {
  try {
    return await readNote(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}

export function notePrivate(source: string): boolean {
  return parseFrontmatter(splitFrontmatter(source).raw).data.private
}

export function metadataValue(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const DESCRIPTION_PREFIX = '- Description: '

function descriptionLineIndex(metadataLines: readonly string[]): number {
  return metadataLines.findIndex((candidate) => candidate.startsWith(DESCRIPTION_PREFIX))
}

/** Does the raw body already carry a description metadata bullet? */
export function hasDescription(body: string): boolean {
  return descriptionLineIndex(body.slice(0, firstSectionStart(body)).split('\n')) !== -1
}

/** The capture's persisted metadata description, when present. */
export function captureDescriptionFromBody(body: string): string | undefined {
  const metadataLines = body.slice(0, firstSectionStart(body)).split('\n')
  const descriptionLine = descriptionLineIndex(metadataLines)
  if (descriptionLine === -1) {
    return undefined
  }
  const description = metadataValue(metadataLines[descriptionLine]!.slice(DESCRIPTION_PREFIX.length))
  return description === '' ? undefined : description
}

/**
 * Rewrite the capture note's display title — the leading H1 the drain wrote,
 * plus the screenshot alt text that mirrors it. The caller has already
 * verified the body is the unedited drain-written shape (hash check), so a
 * missing heading is a bug, not user data.
 */
export function withTitle(body: string, title: string): string {
  const newlineAt = body.indexOf('\n')
  const firstLine = newlineAt === -1 ? body : body.slice(0, newlineAt)
  if (!firstLine.startsWith('# ')) {
    throw new Error('capture note is missing its title heading')
  }
  const oldTitle = firstLine.slice(2)
  if (oldTitle === title) {
    return body
  }
  const retitled = `# ${title}${newlineAt === -1 ? '' : body.slice(newlineAt)}`
  const screenshot = `## Screenshot\n\n![${oldTitle}](`
  const screenshotAt = retitled.lastIndexOf(screenshot)
  if (screenshotAt === -1) {
    return retitled
  }
  return (
    retitled.slice(0, screenshotAt) +
    `## Screenshot\n\n![${title}](` +
    retitled.slice(screenshotAt + screenshot.length)
  )
}

/**
 * Rewrite a daily entry's wiki-link display text after its capture note was
 * retitled. Both writers (the drain's dedup refresh and the enrichment
 * retitle) keep the invariant "daily link text mirrors the note's H1", so the
 * rewrite fires only when the entry still reads `from` verbatim — a mismatch
 * means the user edited the daily and their text wins. The link target (the
 * stable capture id) never changes.
 */
export function retitleDailyEntry(
  dailySource: string,
  base: string,
  from: string,
  to: string,
): string {
  if (from === to) {
    return dailySource
  }
  const entry = `[[${base}|${from}]]`
  if (!dailySource.includes(entry)) {
    return dailySource
  }
  // Function replacer: `$` sequences in titles must stay literal.
  return dailySource.replace(entry, () => `[[${base}|${to}]]`)
}

/**
 * Insert or replace the description metadata bullet for link captures. The
 * raw body has a `- Type: #link` anchor.
 */
export function withDescription(body: string, description: string): string {
  const line = `${DESCRIPTION_PREFIX}${metadataValue(description)}`
  const metadataEnd = firstSectionStart(body)
  const metadataLines = body.slice(0, metadataEnd).split('\n')
  const descriptionLine = descriptionLineIndex(metadataLines)
  if (descriptionLine !== -1) {
    metadataLines[descriptionLine] = line
    return `${metadataLines.join('\n')}${body.slice(metadataEnd)}`
  }
  const typeLine = metadataLines.findIndex((candidate) => candidate.trimEnd() === '- Type: #link')
  if (typeLine === -1) {
    throw new Error('capture note is missing Type metadata')
  }
  metadataLines.splice(typeLine + 1, 0, line)
  return `${metadataLines.join('\n')}${body.slice(metadataEnd)}`
}
