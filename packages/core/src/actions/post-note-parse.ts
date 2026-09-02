import type { CapturedPost, PostAuthor, QuotedPost } from './capture-envelope'
import { POST_NOTE_MARKUP, type PostNoteFields, type PostNoteMedia } from './post-note-markup'
import { readMoreLine } from './post-note-render'
import { parsePostUrl, POST_HANDLE_RE } from './post-url'

/**
 * Parsing half of the post note template — see `post-note.ts`. Strict by
 * design: the parser only ever runs on a body the capture hash proved
 * unedited, so a shape it does not recognize is a template/parser mismatch,
 * never user content. The round-trip test pins the two halves together.
 */

const markup = POST_NOTE_MARKUP

function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
}

const HANDLE = POST_HANDLE_RE.source.slice(1, -1)
const AUTHOR_RE = new RegExp(
  String.raw`^${escapeRegExp(markup.authorPrefix)}\[(.*)\]\(https://x\.com/(${HANDLE})\) \(@\2\)$`,
)
const IMAGE_RE = /^!\[(.*)\]\((\S+)\)$/
const WATCH_RE = new RegExp(String.raw`^\[${escapeRegExp(markup.watch)}\]\(\S+\)$`)
const QUOTING_RE = new RegExp(
  String.raw`^${escapeRegExp(markup.quoting)} \[(.*) \(@(${HANDLE})\)\]\((\S+)\):$`,
)

function unquote(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      if (line === '>') {
        return ''
      }
      if (line.startsWith('> ')) {
        return line.slice(2)
      }
      throw new Error('post note quote block has a non-quoted line')
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

interface Metadata {
  url: string
  author: PostAuthor | null
  postedAt: string | null
}

function parseMetadata(block: string): Metadata {
  let url: string | null = null
  let author: PostAuthor | null = null
  let postedAt: string | null = null
  for (const line of block.split('\n')) {
    if (line.startsWith(markup.urlPrefix)) {
      url = line.slice(markup.urlPrefix.length)
    } else if (line.startsWith(markup.postedPrefix)) {
      postedAt = line.slice(markup.postedPrefix.length)
    } else if (line !== markup.typeLine) {
      const match = AUTHOR_RE.exec(line)
      if (match === null) {
        throw new Error('post note has an unrecognized metadata line')
      }
      author = { name: match[1]!, handle: match[2]! }
    }
  }
  if (url === null) {
    throw new Error('post note is missing its URL')
  }
  return { url, author, postedAt }
}

function parseQuotingHeader(block: string): QuotedPost | null {
  const match = QUOTING_RE.exec(block)
  if (match === null) {
    return null
  }
  const url = match[3]!
  return {
    id: parsePostUrl(url)?.id ?? '',
    url,
    author: { name: match[1]!, handle: match[2]! },
  }
}

/**
 * Read a drain-written post note body back into its fields. Throws on any
 * shape the template does not produce.
 */
export function parsePostNoteBody(body: string): PostNoteFields & { title: string } {
  const [heading, metadataBlock, ...blocks] = body.replace(/\n$/, '').split('\n\n')
  if (heading === undefined || !heading.startsWith('# ') || metadataBlock === undefined) {
    throw new Error('post note is missing its heading or metadata')
  }
  const title = heading.slice(2)
  const { url, author, postedAt } = parseMetadata(metadataBlock)

  let text: string | null = null
  let truncated = false
  let media: PostNoteMedia[] = []
  let quoted: QuotedPost | null = null
  let note: string | null = null
  let screenshot: string | null = null
  let quotingHeader: QuotedPost | null = null
  let noteBlocks: string[] | null = null
  let expectingScreenshot = false
  const readMore = readMoreLine(url)

  for (const block of blocks) {
    if (expectingScreenshot) {
      const image = IMAGE_RE.exec(block)
      if (image === null) {
        throw new Error('post note screenshot section is malformed')
      }
      screenshot = image[2]!
      expectingScreenshot = false
      continue
    }
    if (block === markup.screenshotHeading) {
      if (noteBlocks !== null) {
        note = noteBlocks.join('\n\n')
        noteBlocks = null
      }
      expectingScreenshot = true
      continue
    }
    if (block === markup.noteHeading) {
      noteBlocks = []
      continue
    }
    if (noteBlocks !== null) {
      noteBlocks.push(block)
      continue
    }
    const quoting = parseQuotingHeader(block)
    if (quoting !== null) {
      quotingHeader = quoting
      quoted = quoting
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
  if (expectingScreenshot) {
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
