import { z } from 'zod'
import type { CloudSafe } from '../privacy/checkers'
import { call } from '../ipc/invoke'

const LINK_PREVIEW_HTML_MAX_CHARS = 2 * 1024 * 1024
const LINK_PREVIEW_ICON_MAX_CHARS = 64 * 1024
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

const httpUrlSchema = z.url().refine((value) => {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
})

const linkPreviewHtmlSchema = z.object({
  html: z.string().max(LINK_PREVIEW_HTML_MAX_CHARS),
  finalUrl: httpUrlSchema,
})

const linkPreviewIconSchema = z
  .string()
  .max(LINK_PREVIEW_ICON_MAX_CHARS)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u)
  .refine((value) => value.slice(PNG_DATA_URL_PREFIX.length).length % 4 === 0)

/** Bounded, public-network-only HTML returned for editor link metadata. */
export type LinkPreviewHtml = z.infer<typeof linkPreviewHtmlSchema>

/**
 * Fetch an HTTP(S) page for an editor link preview. The native transport
 * rejects non-public destinations before each request and redirect.
 */
export async function linkPreviewFetchHtml(url: CloudSafe<string>): Promise<LinkPreviewHtml> {
  return await call('link_preview_fetch_html', { url }, linkPreviewHtmlSchema)
}

/** Fetch and normalize a public raster favicon into a small PNG data URL. */
export async function linkPreviewFetchIcon(url: CloudSafe<string>): Promise<string> {
  return await call('link_preview_fetch_icon', { url }, linkPreviewIconSchema)
}
