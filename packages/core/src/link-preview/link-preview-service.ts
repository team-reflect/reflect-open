import type { WebFetchService } from './web-fetch-service.ts'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import { isAppError } from '../errors.ts'
import type { GraphSessionService } from '../graph/graph-session-service.ts'
import type { CloudSafe } from '../privacy/cloud-safe.ts'
import type { PrivacyService } from '../privacy/privacy-service.ts'
import type { parseLinkPreviewMeta } from './metadata.ts'

/**
 * Immutable identity of the note and editor session that owns a resolver.
 */
export interface LinkPreviewSession {
  /**
   * Graph-relative note path whose live source supplies the privacy flag.
   */
  readonly path: string
  /**
   * Stable graph-root identity used to reject results from another graph.
   */
  readonly graphKey: string
  /**
   * Open-document epoch used to reject results from a replaced editor session.
   */
  readonly sessionEpoch: number
}

/**
 * The display metadata of one link, as the editor's preview card shows it.
 */
export interface LinkPreview {
  readonly title: string
  readonly description?: string | undefined
  readonly iconSrc?: string | undefined
}

/**
 * Resolve display metadata for a link, or `undefined` when unavailable.
 */
export type LinkPreviewResolver = (href: string) => Promise<LinkPreview | undefined>

export interface LinkPreviewServiceDeps {
  /**
   * Reads the note's live full markdown through the open-document registry.
   */
  readonly noteDocuments: NoteDocumentService
  readonly privacy: PrivacyService
  /**
   * Fetches bounded page HTML and a bounded raster favicon, each from a privacy-authorized URL.
   */
  readonly webFetch: WebFetchService
  /**
   * Parses and validates bounded display metadata from the fetched page. Needs a `DOMParser`.
   */
  readonly parseMetadata: typeof parseLinkPreviewMeta
  readonly graphSession: GraphSessionService
}

/**
 * The privacy-gated expansion of the HTTP(S) links in a note.
 */
export interface LinkPreviewService {
  /**
   * Build the resolver of one editor session. `currentSession` reports the
   * session the editor shows now; a lookup of a replaced session resolves
   * `undefined`. Source reads go to the graph open when the resolver is
   * built; with none, every lookup resolves `undefined`. The returned promise cache includes successful and permanent
   * failed lookups, deduplicates concurrent calls, and leaves transient
   * network failures eligible for retry.
   */
  createResolver(
    session: LinkPreviewSession,
    currentSession: () => LinkPreviewSession | null,
  ): LinkPreviewResolver
}

type LinkPreviewResolution =
  | {
      readonly kind: 'resolved'
      readonly preview: LinkPreview | undefined
      readonly cacheable: boolean
    }
  | { readonly kind: 'authorization-denied' }
  | { readonly kind: 'transient-failure' }

const AUTHORIZATION_DENIED: LinkPreviewResolution = { kind: 'authorization-denied' }
const TRANSIENT_FAILURE: LinkPreviewResolution = { kind: 'transient-failure' }
const FAILED_RESOLUTION: LinkPreviewResolution = {
  kind: 'resolved',
  preview: undefined,
  cacheable: true,
}

function sameSession(left: LinkPreviewSession | null, right: LinkPreviewSession): boolean {
  return (
    left?.path === right.path &&
    left.graphKey === right.graphKey &&
    left.sessionEpoch === right.sessionEpoch
  )
}

function isTransientFailure(error: unknown): boolean {
  return isAppError(error) && error.kind === 'network'
}

class LinkPreviewServiceImpl implements LinkPreviewService {
  readonly #deps: LinkPreviewServiceDeps

  constructor(deps: LinkPreviewServiceDeps) {
    this.#deps = deps
  }

  createResolver(
    session: LinkPreviewSession,
    currentSession: () => LinkPreviewSession | null,
  ): LinkPreviewResolver {
    const { noteDocuments, privacy, webFetch, parseMetadata, graphSession } = this.#deps
    const graph = graphSession.getState().session
    const cache = new Map<string, Promise<LinkPreviewResolution>>()

    async function authorizeOutboundUrls(
      urls: readonly string[],
    ): Promise<readonly CloudSafe<string>[] | null> {
      if (graph === null || !sameSession(currentSession(), session)) return null
      try {
        const source = await noteDocuments.readExisting(session.path, graph.generation)
        if (!sameSession(currentSession(), session)) return null
        const note = { path: session.path, isPrivate: privacy.notePrivate(source) }
        return urls.map((url) => privacy.cloudSafeLinkHref(note, url))
      } catch {
        return null
      }
    }

    async function resolve(
      href: string,
      pageUrl: CloudSafe<string>,
    ): Promise<LinkPreviewResolution> {
      let page
      try {
        page = await webFetch.fetchLinkPreviewHtml(pageUrl)
      } catch (error) {
        return isTransientFailure(error) ? TRANSIENT_FAILURE : FAILED_RESOLUTION
      }

      let metadata
      try {
        metadata = parseMetadata(page.html, page.finalUrl)
      } catch {
        return FAILED_RESOLUTION
      }
      if (metadata === null) return FAILED_RESOLUTION

      // One live snapshot re-checks the page and separately mints the favicon
      // URL immediately before its outbound request.
      const authorizedUrls = await authorizeOutboundUrls([href, metadata.iconUrl])
      if (authorizedUrls === null) return AUTHORIZATION_DENIED
      const iconUrl = authorizedUrls[1]
      if (iconUrl === undefined) return FAILED_RESOLUTION

      let iconSrc: string | undefined
      let cacheable = true
      try {
        iconSrc = await webFetch.fetchLinkPreviewIcon(iconUrl)
      } catch (error) {
        cacheable = !isTransientFailure(error)
        // A favicon is optional; the card falls back to a globe.
      }

      // A result is usable only while its source note and editor session remain public.
      if ((await authorizeOutboundUrls([href])) === null) return AUTHORIZATION_DENIED

      return {
        kind: 'resolved',
        preview: {
          title: metadata.title,
          ...(metadata.description === null ? {} : { description: metadata.description }),
          iconSrc,
        },
        cacheable,
      }
    }

    return async (href) => {
      try {
        const url = new URL(href)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return
      } catch {
        return
      }

      // Authorization is deliberately outside the cache: a completed preview
      // must disappear as soon as its note becomes private, while a denied
      // lookup must become eligible when the note becomes public again.
      const authorizedPageUrls = await authorizeOutboundUrls([href])
      if (authorizedPageUrls === null) return
      const pageUrl = authorizedPageUrls[0]
      if (pageUrl === undefined) return

      let pending = cache.get(href)
      if (pending === undefined) {
        pending = resolve(href, pageUrl)
        cache.set(href, pending)
      }
      const resolution = await pending
      if (
        resolution.kind === 'authorization-denied' ||
        resolution.kind === 'transient-failure' ||
        !resolution.cacheable
      ) {
        if (cache.get(href) === pending) cache.delete(href)
      }
      if (resolution.kind !== 'resolved') {
        return
      }
      return resolution.preview
    }
  }
}

export function createLinkPreviewService(deps: LinkPreviewServiceDeps): LinkPreviewService {
  return new LinkPreviewServiceImpl(deps)
}
