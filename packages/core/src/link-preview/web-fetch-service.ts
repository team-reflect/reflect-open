import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { CloudSafe } from '../privacy/cloud-safe.ts'

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

/**
 * Bounded, public-network-only HTML returned for editor link metadata.
 */
export type LinkPreviewHtml = z.infer<typeof linkPreviewHtmlSchema>

/**
 * Bounded outbound web fetches the native side performs (scheme, size,
 * timeout and redirect caps), so the webview's own HTTP capability never
 * widens. Every URL must have passed the privacy gate.
 */
export interface WebFetchService {
  /**
   * A captured page's HTML, for meta-tag scraping.
   */
  fetchMeta(url: CloudSafe<string>): MaybePromise<string>
  /**
   * An oEmbed endpoint's JSON answer as text. Only `https` JSON answers without redirects.
   */
  fetchOembed(url: CloudSafe<string>): MaybePromise<string>
  /**
   * One representative image for a captured URL as a base64 JPEG, or `null` when unavailable.
   */
  fetchLinkPreviewImage(url: CloudSafe<string>): MaybePromise<string | null>
  /**
   * An HTTP(S) page for an editor link preview. Non-public destinations are refused.
   */
  fetchLinkPreviewHtml(url: CloudSafe<string>): MaybePromise<LinkPreviewHtml>
  /**
   * A public raster favicon, normalized into a small PNG data URL.
   */
  fetchLinkPreviewIcon(url: CloudSafe<string>): MaybePromise<string>
}

export interface WebFetchServiceDeps {
  readonly ipc: IpcBridgeService
}

class WebFetchServiceImpl implements WebFetchService {
  readonly #deps: WebFetchServiceDeps

  constructor(deps: WebFetchServiceDeps) {
    this.#deps = deps
  }

  async fetchMeta(url: CloudSafe<string>): Promise<string> {
    return await this.#deps.ipc.call('capture_meta_fetch', { url }, z.string())
  }

  async fetchOembed(url: CloudSafe<string>): Promise<string> {
    return await this.#deps.ipc.call('capture_oembed_fetch', { url }, z.string())
  }

  async fetchLinkPreviewImage(url: CloudSafe<string>): Promise<string | null> {
    return await this.#deps.ipc.call('capture_link_preview', { url }, z.string().nullable())
  }

  async fetchLinkPreviewHtml(url: CloudSafe<string>): Promise<LinkPreviewHtml> {
    return await this.#deps.ipc.call('link_preview_fetch_html', { url }, linkPreviewHtmlSchema)
  }

  async fetchLinkPreviewIcon(url: CloudSafe<string>): Promise<string> {
    return await this.#deps.ipc.call('link_preview_fetch_icon', { url }, linkPreviewIconSchema)
  }
}

export function createWebFetchService(deps: WebFetchServiceDeps): WebFetchService {
  return new WebFetchServiceImpl(deps)
}
