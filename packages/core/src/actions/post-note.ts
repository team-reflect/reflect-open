import { normalizedPageTitle } from '../ai/describe-page'
import { wikiLinkSafe } from '../markdown/edit'
import type { CapturedPost, PostAuthor, PostMedia, QuotedPost } from './capture-envelope'
import { profileUrl } from './post-url'

/**
 * The post capture note (Plan 25): one template, rendered by the drain from
 * what the page read and re-rendered by enrichment from the merged post, and
 * one parser that reads the drain-written body back so enrichment can merge
 * without a second copy of the page fields anywhere. The parser is only ever
 * run on a body the capture hash proved unedited, so it is strict: a shape it
 * does not recognize is a bug, not user data.
 */

/** One media line: a remote image, or a promoted local asset. */
export interface PostNoteMedia {
  kind: PostMedia['kind']
  /** Remote https URL before enrichment, `assets/…` after. */
  src: string
  alt: string
}

/** Everything the post note body shows. */
export interface PostNoteFields {
  url: string
  author: PostAuthor | null
  /** ISO-8601; rendered as a date. */
  postedAt: string | null
  text: string | null
  truncated: boolean
  media: readonly PostNoteMedia[]
  quoted: QuotedPost | null
  /** The user's note from the capture UI. */
  note: string | null
  /** Graph-relative screenshot asset, when the capture carried one. */
  screenshot: string | null
}

const TYPE_LINE = '- Type: #tweet'
const READ_MORE = 'Read the full post on X'
const WATCH = 'Watch on X'
const QUOTING = '**Quoting**'

function linkText(text: string): string {
  return wikiLinkSafe(text).replaceAll(/[()]/g, ' ').replaceAll(/\s+/g, ' ').trim()
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.replaceAll(/\s+/g, ' ').trim())
      .find((line) => line !== '') ?? ''
  )
}

/** `2006-03-21` from an ISO timestamp, or the raw value when unparseable. */
function postedDate(postedAt: string): string {
  const date = new Date(postedAt)
  return Number.isNaN(date.getTime()) ? postedAt : date.toISOString().slice(0, 10)
}

function authorLabel(author: PostAuthor): string {
  return `${linkText(author.name)} (@${author.handle})`
}

/**
 * The note's display title: `Name (@handle): first line…`, wiki-link safe
 * and clipped like every capture title. Falls back to `fallback` (the tab
 * title or host the drain would use) when neither author nor text is known.
 */
export function postNoteTitle(
  fields: Pick<PostNoteFields, 'author' | 'text'>,
  fallback: string,
): string {
  const line = fields.text === null ? '' : firstLine(fields.text)
  let candidate: string
  if (fields.author !== null && line !== '') {
    candidate = `${authorLabel(fields.author)}: ${line}`
  } else if (fields.author !== null) {
    candidate = `${authorLabel(fields.author)} on X`
  } else if (line !== '') {
    candidate = `Post on X: ${line}`
  } else {
    return fallback
  }
  return normalizedPageTitle(candidate) ?? fallback
}

function quoteLines(text: string): string {
  return text
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** Render the post note body — everything below the frontmatter. */
export function postNoteBody(fields: PostNoteFields, title: string): string {
  const metadata = [`- URL: ${fields.url}`, TYPE_LINE]
  if (fields.author !== null) {
    metadata.push(
      `- Author: [${linkText(fields.author.name)}](${profileUrl(fields.author.handle)}) (@${fields.author.handle})`,
    )
  }
  if (fields.postedAt !== null) {
    metadata.push(`- Posted: ${postedDate(fields.postedAt)}`)
  }
  const parts = [`# ${title}`, metadata.join('\n')]
  if (fields.text !== null && fields.text.trim() !== '') {
    const quoted = quoteLines(fields.text.trim())
    parts.push(fields.truncated ? `${quoted}\n> [${READ_MORE}](${fields.url})` : quoted)
  } else if (fields.truncated) {
    parts.push(`> [${READ_MORE}](${fields.url})`)
  }
  if (fields.media.length > 0) {
    parts.push(
      fields.media
        .map((item) => {
          const image = `![${linkText(item.alt)}](${item.src})`
          return item.kind === 'image' ? image : `${image}\n[${WATCH}](${fields.url})`
        })
        .join('\n'),
    )
  }
  if (fields.quoted !== null) {
    parts.push(`${QUOTING} [${authorLabel(fields.quoted.author)}](${fields.quoted.url}):`)
    if (fields.quoted.text !== undefined && fields.quoted.text.trim() !== '') {
      parts.push(quoteLines(fields.quoted.text.trim()))
    }
  }
  if (fields.note !== null && fields.note.trim() !== '') {
    parts.push(`## Note\n\n${fields.note.trim()}`)
  }
  if (fields.screenshot !== null) {
    parts.push(`## Screenshot\n\n![${title}](${fields.screenshot})`)
  }
  return `${parts.join('\n\n')}\n`
}

/** The template's fields for a captured post, as the drain renders it. */
export function postNoteFields(
  url: string,
  post: CapturedPost,
  options: { note?: string | undefined; screenshot: string | null },
): PostNoteFields {
  return {
    url,
    author: post.author ?? null,
    postedAt: post.postedAt ?? null,
    text: post.text ?? null,
    truncated: post.truncated === true,
    media: (post.media ?? []).map((item) => ({
      kind: item.kind,
      src: item.url,
      alt: item.alt ?? '',
    })),
    quoted: post.quoted ?? null,
    note: options.note?.trim() ? options.note.trim() : null,
    screenshot: options.screenshot,
  }
}

const AUTHOR_RE = /^- Author: \[(.*)\]\(https:\/\/x\.com\/(\w{1,50})\) \(@\2\)$/
const IMAGE_RE = /^!\[(.*)\]\((\S+)\)$/
const WATCH_RE = /^\[Watch on X\]\(\S+\)$/
const QUOTING_RE = /^\*\*Quoting\*\* \[(.*) \(@(\w{1,50})\)\]\((\S+)\):$/

function unquote(block: string): string {
  return block
    .split('\n')
    .map((line) => (line === '>' ? '' : line.startsWith('> ') ? line.slice(2) : null))
    .map((line) => {
      if (line === null) {
        throw new Error('post note quote block has a non-quoted line')
      }
      return line
    })
    .join('\n')
}

function parseMediaBlock(block: string): PostNoteMedia[] {
  const media: PostNoteMedia[] = []
  for (const line of block.split('\n')) {
    const image = IMAGE_RE.exec(line)
    if (image !== null) {
      media.push({ kind: 'image', src: image[2]!, alt: image[1]! })
      continue
    }
    const last = media.at(-1)
    if (WATCH_RE.test(line) && last !== undefined) {
      last.kind = 'video'
      continue
    }
    throw new Error('post note media block has an unrecognized line')
  }
  return media
}

/**
 * Read a drain-written post note body back into its fields. Throws on any
 * shape the template does not produce — callers only pass hash-verified
 * bodies, so that is a template/parser mismatch, never user content.
 */
export function parsePostNoteBody(body: string): PostNoteFields & { title: string } {
  const [heading, metadataBlock, ...blocks] = body.replace(/\n$/, '').split('\n\n')
  if (heading === undefined || !heading.startsWith('# ') || metadataBlock === undefined) {
    throw new Error('post note is missing its heading or metadata')
  }
  const title = heading.slice(2)
  let url: string | null = null
  let author: PostAuthor | null = null
  let postedAt: string | null = null
  for (const line of metadataBlock.split('\n')) {
    if (line.startsWith('- URL: ')) {
      url = line.slice('- URL: '.length)
    } else if (line.startsWith('- Posted: ')) {
      postedAt = line.slice('- Posted: '.length)
    } else {
      const match = AUTHOR_RE.exec(line)
      if (match !== null) {
        author = { name: match[1]!, handle: match[2]! }
      } else if (line !== TYPE_LINE) {
        throw new Error('post note has an unrecognized metadata line')
      }
    }
  }
  if (url === null) {
    throw new Error('post note is missing its URL')
  }

  let text: string | null = null
  let truncated = false
  let media: PostNoteMedia[] = []
  let quoted: QuotedPost | null = null
  let note: string | null = null
  let screenshot: string | null = null
  let quotingHeader: QuotedPost | null = null
  let noteBlocks: string[] | null = null
  const readMore = `> [${READ_MORE}](${url})`

  for (const block of blocks) {
    if (block === '## Screenshot') {
      if (noteBlocks !== null) {
        note = noteBlocks.join('\n\n')
        noteBlocks = null
      }
      screenshot = 'pending'
      continue
    }
    if (screenshot === 'pending') {
      const image = IMAGE_RE.exec(block)
      if (image === null) {
        throw new Error('post note screenshot section is malformed')
      }
      screenshot = image[2]!
      continue
    }
    if (block === '## Note') {
      noteBlocks = []
      continue
    }
    if (noteBlocks !== null) {
      noteBlocks.push(block)
      continue
    }
    const quoting = QUOTING_RE.exec(block)
    if (quoting !== null) {
      quotingHeader = {
        id: quoting[3]!.split('/').at(-1) ?? '',
        url: quoting[3]!,
        author: { name: quoting[1]!, handle: quoting[2]! },
      }
      quoted = quotingHeader
      continue
    }
    if (block.startsWith('>')) {
      if (quotingHeader !== null) {
        quoted = { ...quotingHeader, text: unquote(block) }
        quotingHeader = null
        continue
      }
      const lines = block.split('\n')
      if (lines.at(-1) === readMore) {
        truncated = true
        lines.pop()
      }
      text = lines.length === 0 ? null : unquote(lines.join('\n'))
      continue
    }
    if (block.startsWith('![')) {
      media = parseMediaBlock(block)
      continue
    }
    throw new Error('post note has an unrecognized block')
  }
  if (noteBlocks !== null) {
    note = noteBlocks.join('\n\n')
  }
  if (screenshot === 'pending') {
    throw new Error('post note screenshot section is missing its image')
  }
  return { title, url, author, postedAt, text, truncated, media, quoted, note, screenshot }
}

/**
 * The captured-post view of parsed note fields — what the page read, for
 * the merge with the endpoint's answer. Only remote media survive (a
 * pending body has never been localized, but the type says so).
 */
export function capturedPostFromFields(
  fields: PostNoteFields,
  identity: { id: string; trigger: CapturedPost['trigger'] },
): CapturedPost {
  const media = fields.media
    .filter((item) => item.src.startsWith('https://'))
    .map((item) => ({
      kind: item.kind,
      url: item.src,
      ...(item.alt === '' ? {} : { alt: item.alt }),
    }))
  return {
    provider: 'x',
    id: identity.id,
    trigger: identity.trigger,
    ...(fields.author === null ? {} : { author: fields.author }),
    ...(fields.text === null ? {} : { text: fields.text }),
    ...(fields.truncated ? { truncated: true } : {}),
    ...(fields.postedAt === null ? {} : { postedAt: fields.postedAt }),
    ...(media.length === 0 ? {} : { media }),
    ...(fields.quoted === null ? {} : { quoted: fields.quoted }),
  }
}
