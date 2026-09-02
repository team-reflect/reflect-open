/**
 * The post capture note (Plan 25): one template, rendered by the drain from
 * what the page read and re-rendered by enrichment from the merged post
 * (`post-note-render.ts`), and one parser that reads the drain-written body
 * back so enrichment can merge without a second copy of the page fields
 * anywhere (`post-note-parse.ts`). Both share `post-note-markup.ts`.
 */
export { POST_NOTE_MARKUP, type PostNoteFields, type PostNoteMedia } from './post-note-markup'
export { postNoteBody, postNoteFields, postNoteTitle } from './post-note-render'
export { capturedPostFromFields, parsePostNoteBody } from './post-note-parse'
