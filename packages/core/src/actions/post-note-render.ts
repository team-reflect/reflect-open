import { normalizedPageTitle } from '../ai/describe-page'
import { wikiLinkSafe } from '../markdown/edit'
import type { CapturedPost, PostAuthor } from './capture-envelope'
import { POST_NOTE_MARKUP, type PostNoteFields } from './post-note-markup'
import { profileUrl } from './post-url'

/**
 * Rendering half of the post note template — see `post-note.ts`. Every
 * literal comes from `POST_NOTE_MARKUP`; the parser derives its patterns
 * from the same constants.
 */

const markup = POST_NOTE_MARKUP

/** Markdown-link-safe text: no brackets, parens, pipes, or line breaks. */
export function linkText(text: string): string {
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

/** `Name (@handle)`, as the title and the quoting line spell an author. */
export function authorLabel(author: PostAuthor): string {
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

/** The trailing quote line a truncated post ends with. */
export function readMoreLine(url: string): string {
  return `> [${markup.readMore}](${url})`
}

/** Render the post note body — everything below the frontmatter. */
export function postNoteBody(fields: PostNoteFields, title: string): string {
  const metadata = [`${markup.urlPrefix}${fields.url}`, markup.typeLine]
  if (fields.author !== null) {
    metadata.push(
      `${markup.authorPrefix}[${linkText(fields.author.name)}](${profileUrl(fields.author.handle)}) (@${fields.author.handle})`,
    )
  }
  if (fields.postedAt !== null) {
    metadata.push(`${markup.postedPrefix}${postedDate(fields.postedAt)}`)
  }
  const parts = [`# ${title}`, metadata.join('\n')]
  if (fields.text !== null && fields.text.trim() !== '') {
    const quoted = quoteLines(fields.text.trim())
    parts.push(fields.truncated ? `${quoted}\n${readMoreLine(fields.url)}` : quoted)
  } else if (fields.truncated) {
    parts.push(readMoreLine(fields.url))
  }
  if (fields.media.length > 0) {
    parts.push(
      fields.media
        .map((item) => {
          const image = `![${linkText(item.alt)}](${item.src})`
          return item.kind === 'image' ? image : `${image}\n[${markup.watch}](${fields.url})`
        })
        .join('\n'),
    )
  }
  if (fields.quoted !== null) {
    parts.push(`${markup.quoting} [${authorLabel(fields.quoted.author)}](${fields.quoted.url}):`)
    if (fields.quoted.text !== undefined && fields.quoted.text.trim() !== '') {
      parts.push(quoteLines(fields.quoted.text.trim()))
    }
  }
  if (fields.note !== null && fields.note.trim() !== '') {
    parts.push(`${markup.noteHeading}\n\n${fields.note.trim()}`)
  }
  if (fields.screenshot !== null) {
    parts.push(`${markup.screenshotHeading}\n\n![${title}](${fields.screenshot})`)
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

/**
 * The fields for a same-day re-capture of a post that already has a note:
 * what the new envelope read wins where it has something, the existing note
 * fills the rest (a bookmark's author/text/media survive a later URL-only
 * ⌘⇧K), full text beats a truncated preview whichever side has it, and a
 * user note from the new capture is added.
 */
export function refreshPostNoteFields(
  existing: PostNoteFields,
  incoming: CapturedPost,
  options: { url: string; note?: string | undefined; screenshot: string | null },
): PostNoteFields {
  const fresh = postNoteFields(options.url, incoming, options)
  const incomingFull = fresh.text !== null && !fresh.truncated
  const existingFull = existing.text !== null && !existing.truncated
  let text: string | null
  if (incomingFull) {
    text = fresh.text
  } else if (existingFull) {
    text = existing.text
  } else {
    text = (fresh.text?.length ?? 0) >= (existing.text?.length ?? 0) ? fresh.text : existing.text
  }
  return {
    url: options.url,
    author: fresh.author ?? existing.author,
    postedAt: fresh.postedAt ?? existing.postedAt,
    text,
    truncated: text !== null && !incomingFull && !existingFull,
    media: fresh.media.length > 0 ? fresh.media : existing.media,
    quoted: fresh.quoted ?? existing.quoted,
    note: fresh.note ?? existing.note,
    screenshot: options.screenshot ?? existing.screenshot,
  }
}
