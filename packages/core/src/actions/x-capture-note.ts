import { z } from 'zod'
import { ReflectError } from '../errors'
import { assetPath, dailyPath, notePath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import type { Frontmatter } from '../markdown/model'
import type { CaptureEnvelope } from './capture-envelope'
import type { CaptureIdentity } from './capture-identity'
import { captureNoteMeta, metadataValue, type CaptureNoteMeta } from './capture-note'
import { xPostId, xPostURL } from './x-post'
import type { XText } from './x-syndication'

const X_PATH = /^notes\/capture-x-text-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/

/** Recognize the reserved filename family, including damaged identities. */
export function isXCapturePath(path: string): boolean {
  return path.startsWith('notes/capture-x-text-') && path.endsWith('.md')
}

/** X delivery identity is independent of the machine's current timezone. */
export function xCaptureIdentity(id: string, day: string): CaptureIdentity {
  const base = `capture-x-text-${z.guid().parse(id).toLowerCase()}`
  dailyPath(day)
  return { base, date: day, notePath: notePath(base), assetPath: assetPath(`${base}.jpg`) }
}

/** Broken frontmatter cannot establish permission to enrich a capture. */
export function xCaptureFrontmatter(source: string): Frontmatter {
  const split = splitFrontmatter(source)
  const parsed = parseFrontmatter(split.raw)
  if (parsed.warning || (split.raw === null && /^---[ \t]*(?:\r?\n|$)/.test(source))) {
    throw new ReflectError('parse', 'Fix the invalid capture or Daily frontmatter before retrying.')
  }
  return parsed.data
}

export interface XCaptureMeta extends CaptureNoteMeta {
  captureKind: 'x-text'
  captureDay: string
}

/** Validate the persisted X lifecycle without interpreting its Markdown body. */
export function xCaptureMeta(source: string): XCaptureMeta {
  const meta = captureNoteMeta(xCaptureFrontmatter(source))
  if (!meta || meta.captureKind !== 'x-text' || !meta.captureDay
    || !z.iso.date().safeParse(meta.captureDay).success || xPostId(meta.captureUrl) === null) {
    throw new ReflectError('parse', 'The X capture metadata is missing or invalid.')
  }
  return { ...meta, captureKind: 'x-text', captureDay: meta.captureDay }
}

/** Recover the first writer's day from an existing UUID note. */
export function xCaptureFromSource(path: string, source: string): CaptureIdentity {
  const id = X_PATH.exec(path)?.[1]
  if (!id) throw new ReflectError('parse', `Invalid X capture filename: ${path}`)
  return xCaptureIdentity(id, xCaptureMeta(source).captureDay)
}

/** Quote external plain text without activating Markdown images, HTML or links. */
export function xPlainMarkdown(text: string): string {
  return text.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '\\$&')
}

/** Render the raw, durable capture once, preserving the user's annotation. */
export async function xCaptureSource(
  envelope: CaptureEnvelope,
  identity: CaptureIdentity,
  postId: string,
  screenshot: 'none' | 'saved' | 'missing',
  dailySource: string,
): Promise<string> {
  const title = `X post ${postId}`
  const parts = [`# ${title}`, `- URL: ${xPostURL(postId)}\n- Type: #link`]
  if (envelope.title.trim() && envelope.title !== title) {
    parts.push(`- Page title: ${xPlainMarkdown(metadataValue(envelope.title))}`)
  }
  if (envelope.metaDescription?.trim()) {
    parts.push(`- Description: ${xPlainMarkdown(metadataValue(envelope.metaDescription))}`)
  }
  if (envelope.note?.trim()) parts.push(`## Note\n\n${envelope.note}`)
  if (envelope.selection?.trim()) parts.push(`## Selection\n\n${xPlainMarkdown(envelope.selection)}`)
  if (envelope.contentText?.trim()) parts.push(`## Page Text\n\n${xPlainMarkdown(envelope.contentText)}`)
  if (screenshot === 'saved') parts.push(`## Screenshot\n\n![Screenshot](${identity.assetPath})`)
  if (screenshot === 'missing') parts.push('The captured screenshot was unavailable.')
  const body = `${parts.join('\n\n')}\n`
  const isPrivate = xCaptureFrontmatter(dailySource).private
  return upsertFrontmatter(body, {
    aliases: [identity.base],
    private: isPrivate ? true : undefined,
    captureKind: 'x-text',
    captureDay: identity.date,
    captureUrl: xPostURL(postId),
    capturedAt: envelope.capturedAt,
    captureSource: envelope.source,
    captureStatus: isPrivate ? 'skipped' : envelope.contentText?.trim() ? 'done' : 'pending',
    captureHash: await hashContent(body),
    captureScreenshot: screenshot === 'saved' ? identity.assetPath : undefined,
  })
}

/** Append one plain-text result without reconstructing earlier sections. */
export function appendXText(body: string, post: XText | null): string {
  const parts = ['## X post text']
  if (post === null) {
    parts.push('No public text was available. Open the original post using the URL above.')
  } else {
    if (post.author) parts.push(`Author: ${xPlainMarkdown(post.author.name)} (@${xPlainMarkdown(post.author.handle)})`)
    parts.push(xPlainMarkdown(post.text))
    if (post.truncated) parts.push('Only a preview was available. Open the original post for the full text.')
  }
  return body + (body.endsWith('\n') ? '\n' : '\n\n') + parts.join('\n\n') + '\n'
}
