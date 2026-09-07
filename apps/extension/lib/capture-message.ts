import type { CaptureWireMessage, XEnvelope } from '@reflect/core/capture-envelope'
import { CAPTURE_ENVELOPE_MAX_BYTES } from '@reflect/core/x-post'

/**
 * Build the extension→host wire message from what the popup captured. The
 * envelope mirrors `@reflect/core`'s zod schema — the host validates it
 * again; this builder just shapes honest inputs (empty strings become absent
 * optionals, the data-URL prefix is stripped to raw base64).
 */

export interface CapturedPage {
  x?: XEnvelope['x'] | undefined
  url: string
  title: string
  /** `tabs.captureVisibleTab`'s data URL, when the page allowed a screenshot. */
  screenshotDataUrl?: string | undefined
  /** The page's current selection, when the page allowed the script. */
  selection?: string | undefined
  /** Defuddle-extracted page paragraphs, when the user asks to include them. */
  contentText?: string | undefined
  /** The user's comment from the popup. */
  note?: string | undefined
}

/** Only http(s) pages are capturable — the envelope (and product) contract. */
export function isCapturableUrl(url: string | undefined): url is string {
  return url !== undefined && (url.startsWith('https://') || url.startsWith('http://'))
}

function presence(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Strip a `data:image/...;base64,` prefix down to the raw base64 payload. */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

export interface BuildWireMessageInput extends CapturedPage {
  /** Producer-generated UUID (`crypto.randomUUID()`). */
  id: string
  /** The capture moment. */
  capturedAt: Date
}

export function buildWireMessage(input: BuildWireMessageInput): CaptureWireMessage {
  const common = {
    id: input.id,
    url: input.url,
    title: input.title.trim(),
    selection: presence(input.selection),
    note: presence(input.note),
    capturedAt: input.capturedAt.toISOString(),
    source: 'extension' as const,
  }
  const envelope = input.x
    ? { ...common, version: 2 as const, x: { ...input.x } }
    : { ...common, version: 1 as const, contentText: presence(input.contentText) }
  function oversized(): boolean {
    const spooled = {
      ...envelope,
      ...(input.screenshotDataUrl ? { screenshotRef: `${input.id}.jpg` } : {}),
    }
    return new TextEncoder().encode(JSON.stringify(spooled)).length > CAPTURE_ENVELOPE_MAX_BYTES
  }
  if (envelope.version === 2 && oversized()) {
    const { quote: _quote, images: _images, ...post } = envelope.x.post
    envelope.x.post = post
    if (oversized() && post.text) {
      const original = post.text.value
      let lower = 0
      let upper = original.length
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2)
        envelope.x.post.text = { value: original.slice(0, middle), complete: false }
        if (oversized()) upper = middle - 1
        else lower = middle
      }
      const value = original.slice(0, lower).replace(/[\uD800-\uDBFF]$/, '')
      if (value) envelope.x.post.text = { value, complete: false }
      else delete envelope.x.post.text
    }
    if (oversized()) {
      throw new Error(
        'This post capture is too large. Shorten the note or selection and try again.',
      )
    }
  }
  return {
    envelope,
    screenshotBase64: input.screenshotDataUrl
      ? dataUrlToBase64(input.screenshotDataUrl)
      : undefined,
  }
}
