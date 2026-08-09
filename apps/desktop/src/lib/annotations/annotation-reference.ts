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
  // The path must be URL-encoded (matching the migration links: spaces →
  // %20, CJK percent-encoded) — a markdown link target with raw spaces fails
  // to parse and renders as plain text; parsePdfHref decodes it back to the
  // on-disk path when clicked.
  return `[${title}](${encodeURI(assetPath)}#page=${page})`
}
