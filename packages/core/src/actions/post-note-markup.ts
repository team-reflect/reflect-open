import type { PostAuthor, PostMedia, QuotedPost } from './capture-envelope'

/**
 * What the two halves of the post note template share (see `post-note.ts`):
 * the field shape and the exact markup strings, so a copy change can never
 * desync render from parse. No imports from either half, so both can import
 * this without a cycle.
 */

/** One media line: a remote image, or a promoted local asset. */
export interface PostNoteMedia {
  kind: PostMedia['kind']
  /** Remote https URL before enrichment, `assets/…` after. */
  src: string
  alt: string
}

/**
 * Everything the post note body shows. Deliberately not `CapturedPost`: the
 * media here may already be local assets, and the note and screenshot are
 * the capture's, not the post's.
 */
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

/** The literal markup the template writes and the parser recognizes. */
export const POST_NOTE_MARKUP = {
  typeLine: '- Type: #tweet',
  urlPrefix: '- URL: ',
  authorPrefix: '- Author: ',
  postedPrefix: '- Posted: ',
  readMore: 'Read the full post on X',
  watch: 'Watch on X',
  quoting: '**Quoting**',
  noteHeading: '## Note',
  screenshotHeading: '## Screenshot',
} as const
