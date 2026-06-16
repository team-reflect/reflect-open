import type { CaptureWireMessage } from '@reflect/core/capture-envelope'

/**
 * Build the extension→host wire message from what the popup captured. The
 * envelope mirrors `@reflect/core`'s zod schema — the host validates it
 * again; this builder just shapes honest inputs (empty strings become absent
 * optionals, the data-URL prefix is stripped to raw base64).
 */

export interface CapturedPage {
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
  return {
    envelope: {
      version: 1,
      id: input.id,
      url: input.url,
      title: input.title.trim(),
      selection: presence(input.selection),
      contentText: presence(input.contentText),
      note: presence(input.note),
      capturedAt: input.capturedAt.toISOString(),
      source: 'extension',
    },
    screenshotBase64: input.screenshotDataUrl
      ? dataUrlToBase64(input.screenshotDataUrl)
      : undefined,
  }
}
