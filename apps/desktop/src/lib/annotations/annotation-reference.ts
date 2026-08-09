import type { AnnotationItem } from './annotations-store'

/**
 * The markdown reference for one PDF annotation, matching the migration
 * product's PDF-link shape: `[<filename> - p<N> - <text>](assets/…pdf#page=N)`.
 * The `text` suffix drops when the annotation carries none. Pasting the link
 * into any note yields a clickable jump back to the PDF's page — the app's
 * `parsePdfHref` already resolves that href shape.
 */
export function annotationReference(assetPath: string, item: AnnotationItem): string {
  const filename =
    assetPath
      .split('/')
      .pop()
      ?.replace(/\.pdf$/i, '') ?? assetPath
  const page = item.pageIndex + 1
  // Collapse whitespace: multiline or run-on spaces would break the one-line
  // link label.
  const text = item.text.trim().replaceAll(/\s+/g, ' ')
  const rawTitle = text === '' ? `${filename} - p${page}` : `${filename} - p${page} - ${text}`
  // Escape markdown special characters once, so they cannot close the link
  // label early.
  const title = rawTitle.replaceAll(/[\\[\]]/g, (c) => `\\${c}`)
  // Encode each path segment with encodeURIComponent (joined by the literal
  // `/`), never the whole path with encodeURI — encodeURI keeps `#` and `?`,
  // and a `#` in a filename would split the href at the wrong place (the
  // fragment must stay the `#page=N` we append). Parentheses are additionally
  // escaped: encodeURIComponent leaves them, but a `)` in a link target would
  // close the markdown link early. parsePdfHref decodes the segments back to
  // the on-disk path when clicked.
  const encodedPath = assetPath
    .split('/')
    .map((segment) => encodeURIComponent(segment).replaceAll('(', '%28').replaceAll(')', '%29'))
    .join('/')
  return `[${title}](${encodedPath}#page=${page})`
}
