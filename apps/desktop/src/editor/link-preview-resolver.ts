import type { LinkPreview, LinkPreviewResolver } from '@meowdown/core'
import {
  cloudSafeLinkHref,
  isAppError,
  linkPreviewFetchHtml,
  linkPreviewFetchIcon,
  notePrivate,
  parseLinkPreviewMeta,
} from '@reflect/core'
import type { CloudSafe } from '@reflect/core'
import { readExistingNoteSource } from '@/lib/read-existing-note-source'

/** Immutable identity of the note and editor session that owns a resolver. */
export interface LinkPreviewSession {
  /** Graph-relative note path whose live source supplies the privacy flag. */
  readonly path: string
  /** Open-graph generation that pins source reads against graph switches. */
  readonly generation: number
  /** Stable graph-root identity used to reject results from another graph. */
  readonly graphKey: string
  /** Open-document epoch used to reject results from a replaced editor session. */
  readonly sessionEpoch: number
}

/** Injectable boundaries used by the pure, session-scoped resolver pipeline. */
export interface LinkPreviewResolverDependencies {
  /** Read the note's live full markdown through the open-document registry. */
  readonly readSource: (path: string, generation: number) => Promise<string>
  /** Fetch bounded page HTML using a privacy-authorized URL. */
  readonly fetchHtml: typeof linkPreviewFetchHtml
  /** Fetch a bounded raster favicon using a privacy-authorized URL. */
  readonly fetchIcon: typeof linkPreviewFetchIcon
  /** Parse and validate bounded display metadata from the fetched page. */
  readonly parseMetadata: typeof parseLinkPreviewMeta
}

const defaultDependencies: LinkPreviewResolverDependencies = {
  readSource: readExistingNoteSource,
  fetchHtml: linkPreviewFetchHtml,
  fetchIcon: linkPreviewFetchIcon,
  parseMetadata: parseLinkPreviewMeta,
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
    left.generation === right.generation &&
    left.graphKey === right.graphKey &&
    left.sessionEpoch === right.sessionEpoch
  )
}

/**
 * Build one editor-session resolver. The returned promise cache includes
 * successful and permanent failed lookups, deduplicates concurrent calls,
 * and leaves transient network failures eligible for retry.
 */
export function createNoteLinkPreviewResolver(
  session: LinkPreviewSession,
  currentSession: () => LinkPreviewSession | null,
  dependencies: LinkPreviewResolverDependencies = defaultDependencies,
): LinkPreviewResolver {
  const cache = new Map<string, Promise<LinkPreviewResolution>>()

  async function authorizeOutboundUrls(
    urls: readonly string[],
  ): Promise<readonly CloudSafe<string>[] | null> {
    if (!sameSession(currentSession(), session)) return null
    try {
      const source = await dependencies.readSource(session.path, session.generation)
      if (!sameSession(currentSession(), session)) return null
      const note = { path: session.path, isPrivate: notePrivate(source) }
      return urls.map((url) => cloudSafeLinkHref(note, url))
    } catch {
      return null
    }
  }

  function isTransientFailure(error: unknown): boolean {
    return isAppError(error) && error.kind === 'network'
  }

  async function resolve(href: string, pageUrl: CloudSafe<string>): Promise<LinkPreviewResolution> {
    let page
    try {
      page = await dependencies.fetchHtml(pageUrl)
    } catch (error) {
      return isTransientFailure(error) ? TRANSIENT_FAILURE : FAILED_RESOLUTION
    }

    let metadata
    try {
      metadata = dependencies.parseMetadata(page.html, page.finalUrl)
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
      iconSrc = await dependencies.fetchIcon(iconUrl)
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
        ...(iconSrc === undefined ? {} : { iconSrc }),
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
