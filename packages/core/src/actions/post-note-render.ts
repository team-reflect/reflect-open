import { normalizedPageTitle } from '../ai/describe-page'
import { wikiLinkSafe } from '../markdown/edit'
import type { CapturedPost, PostAuthor } from './capture-envelope'
import { captureLocalDate } from './capture-identity'
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

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The local calendar day of an ISO timestamp (the day the note filename and
 * daily note use), a date already rendered as is, or the raw value when
 * unparseable.
 */
function postedDate(postedAt: string): string {
  if (DATE_ONLY_RE.test(postedAt)) {
    return postedAt
  }
  const date = new Date(postedAt)
  return Number.isNaN(date.getTime()) ? postedAt : captureLocalDate(date)
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
  if (fields.selection !== null && fields.selection.trim() !== '') {
    parts.push(`${markup.selectionHeading}\n\n${fields.selection.trim()}`)
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
  options: { note?: string | undefined; selection?: string | undefined; screenshot: string | null },
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
    selection: options.selection?.trim() ? options.selection.trim() : null,
    screenshot: options.screenshot,
  }
}

/** Both sections, the earlier one first; the same text twice is one. */
function joinSections(existing: string | null, fresh: string | null): string | null {
  if (existing === null || fresh === null || existing === fresh) {
    return fresh ?? existing
  }
  return `${existing}\n\n${fresh}`
}

/**
 * The fields for a same-day re-capture of a post that already has a note:
 * what the new envelope read wins where it has something, the existing note
 * fills the rest (a bookmark's author/text/media survive a later URL-only
 * ⌘⇧K), full text beats a truncated preview whichever side has it, and a
 * user note or selection from the new capture is appended to the existing one.
 */
export function refreshPostNoteFields(
  existing: PostNoteFields,
  incoming: CapturedPost,
  options: {
    url: string
    note?: string | undefined
    selection?: string | undefined
    screenshot: string | null
  },
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
    note: joinSections(existing.note, fresh.note),
    selection: joinSections(existing.selection, fresh.selection),
    screenshot: options.screenshot ?? existing.screenshot,
  }
}
