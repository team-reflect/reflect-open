import { z } from 'zod'

export const EXTRACT_PAGE_TEXT_MESSAGE_TYPE = 'reflect:capture-page-text'

/** Popup request sent to the injected content script. */
export const extractPageTextRequestSchema = z.object({
  type: z.literal(EXTRACT_PAGE_TEXT_MESSAGE_TYPE),
  expectedUrl: z.url(),
})

/** Content-script reply with normalized paragraph text, or a typed failure. */
export const extractPageTextResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), contentText: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() }),
])

export type ExtractPageTextRequest = z.infer<typeof extractPageTextRequestSchema>
export type ExtractPageTextResponse = z.infer<typeof extractPageTextResponseSchema>

function comparablePageUrl(value: string): string | null {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/** True when two page URLs identify the same document for capture purposes. */
export function samePageUrl(first: string, second: string): boolean {
  const firstUrl = comparablePageUrl(first)
  const secondUrl = comparablePageUrl(second)
  return firstUrl !== null && secondUrl !== null ? firstUrl === secondUrl : first === second
}

/** Collapse intra-paragraph whitespace while preserving paragraph breaks. */
export function normalizeParagraphText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Join non-empty paragraphs into plain text suitable for markdown capture. */
export function formatParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.map(normalizeParagraphText).filter(Boolean).join('\n\n')
}
