import { parsePdfHref, type PdfLinkRef } from './pdf-href'

/**
 * A linked PDF image (`[![…](img)](assets/….pdf#page=N)`) found in rendered
 * markdown: the parsed PDF page target plus the rendered image view an
 * overlay (the zoom button) positions against.
 */
export interface LinkedPdfImageHit {
  /** The parsed PDF page target from the wrapping link's href. */
  ref: PdfLinkRef
  /** meowdown's `.md-image-view` element — the chip's DOM scaffold. */
  view: HTMLElement
  /**
   * The visible box an overlay positions against. Never `view` itself:
   * meowdown styles `.md-atom-view` as `display: contents`, so its rect is
   * zero — the link pack (the padded chip) or the image preview carries the
   * real box.
   */
  chip: HTMLElement
}

/**
 * Resolve a linked PDF image from any element inside its rendered mark view.
 * Clicking such an image must jump to the PDF's page, never open a lightbox
 * or follow the anchor's default navigation.
 *
 * meowdown never nests the image preview inside the anchor: the link's
 * `<a class="md-link">` covers only the hidden markdown source, and the
 * `.md-image-view` sits beside it inside `.md-pack[data-key="link"]` — so a
 * `closest('a')` from the `<img>` finds nothing. The lookup therefore goes
 * through the enclosing link pack (or the source anchor inside the view's
 * content), with the anchor-ancestor shape kept for non-meowdown renderings.
 */
export function linkedPdfImageHitAt(target: Element): LinkedPdfImageHit | null {
  // A click on the chip's padded background lands on the link pack itself (the
  // image view's parent), so look down from the pack as well as up from the
  // image.
  const view =
    target.closest('.md-image-view') ??
    (target.matches('.md-pack[data-key="link"]') ? target.querySelector('.md-image-view') : null)
  if (!(view instanceof HTMLElement)) {
    return null
  }
  const anchor =
    view.closest('a[href]') ??
    view.closest('.md-pack[data-key="link"]')?.querySelector('a[href]') ??
    view.querySelector('.md-image-view-content a[href]') ??
    null
  const ref = parsePdfHref(anchor?.getAttribute('href') ?? '')
  if (ref === null) {
    return null
  }
  const chipCandidate =
    view.closest('.md-pack[data-key="link"]') ??
    view.closest('a[href]') ??
    view.querySelector('.md-image-view-preview')
  const chip = chipCandidate instanceof HTMLElement ? chipCandidate : view
  return { ref, view, chip }
}

/**
 * The image's markdown `src` (the graph-relative `assets/…` path), read back
 * from the view's hidden source (`![alt](src)` inside the content anchor).
 * Null when the source is unreadable — callers degrade to a display-only
 * zoom without the OS-open action.
 */
export function linkedPdfImageSource(hit: LinkedPdfImageHit): string | null {
  const source = hit.view.querySelector('.md-image-view-content a')?.textContent ?? ''
  const match = /!\[[^\]]*\]\(([^)]+)\)/.exec(source)
  return match?.[1]?.trim() ?? null
}

/**
 * The caption shown under a linked PDF image, naming what the chip jumps to —
 * the same role the visible label plays for a text reference. The `.pdf`
 * extension is dropped (the icon and context already say so) and the page
 * keeps the ` - pN` shape used by text-reference labels.
 */
export function linkedPdfImageCaption(ref: PdfLinkRef): string {
  const name = ref.path.split('/').pop() ?? ref.path
  const base = name.replace(/\.pdf$/i, '')
  return ref.page !== undefined ? `${base} - p${ref.page}` : base
}
