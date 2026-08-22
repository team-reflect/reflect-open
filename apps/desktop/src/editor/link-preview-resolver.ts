import type { LinkPreview, LinkPreviewResolver } from '@meowdown/core'
import {
  cloudSafeLinkHref,
  linkPreviewFetchHtml,
  linkPreviewFetchIcon,
  parseFrontmatter,
  parseLinkPreviewMeta,
  splitFrontmatter,
} from '@reflect/core'
import type { CloudSafe } from '@reflect/core'
import { readExistingNoteSource } from '@/lib/read-existing-note-source'

export interface LinkPreviewSession {
  readonly path: string
  readonly generation: number
  readonly graphKey: string
  readonly sessionEpoch: number
}

export interface LinkPreviewResolverDependencies {
  readonly readSource: (path: string, generation: number) => Promise<string>
  readonly fetchHtml: typeof linkPreviewFetchHtml
  readonly fetchIcon: typeof linkPreviewFetchIcon
  readonly parseMetadata: typeof parseLinkPreviewMeta
}

const defaultDependencies: LinkPreviewResolverDependencies = {
  readSource: readExistingNoteSource,
  fetchHtml: linkPreviewFetchHtml,
  fetchIcon: linkPreviewFetchIcon,
  parseMetadata: parseLinkPreviewMeta,
}

type LinkPreviewResolution =
  | { readonly kind: 'resolved'; readonly preview: LinkPreview | undefined }
  | { readonly kind: 'authorization-denied' }

const AUTHORIZATION_DENIED: LinkPreviewResolution = { kind: 'authorization-denied' }
const FAILED_RESOLUTION: LinkPreviewResolution = { kind: 'resolved', preview: undefined }

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
 * successful and failed lookups and naturally deduplicates concurrent calls.
 */
export function createNoteLinkPreviewResolver(
  session: LinkPreviewSession,
  currentSession: () => LinkPreviewSession | null,
  dependencies: LinkPreviewResolverDependencies = defaultDependencies,
): LinkPreviewResolver {
  const cache = new Map<string, Promise<LinkPreviewResolution>>()

  async function authorizeOutboundUrl(url: string): Promise<CloudSafe<string> | null> {
    if (!sameSession(currentSession(), session)) return null
    try {
      const source = await dependencies.readSource(session.path, session.generation)
      if (!sameSession(currentSession(), session)) return null
      const frontmatter = parseFrontmatter(splitFrontmatter(source).raw).data
      return cloudSafeLinkHref({ path: session.path, isPrivate: frontmatter.private }, url)
    } catch {
      return null
    }
  }

  async function resolve(href: string, pageUrl: CloudSafe<string>): Promise<LinkPreviewResolution> {
    let page
    try {
      page = await dependencies.fetchHtml(pageUrl)
    } catch {
      return FAILED_RESOLUTION
    }

    let metadata
    try {
      metadata = dependencies.parseMetadata(page.html, page.finalUrl)
    } catch {
      return FAILED_RESOLUTION
    }
    if (metadata === null) return FAILED_RESOLUTION

    // Re-read privacy after page metadata, then mint the separately resolved
    // favicon URL immediately before its own outbound request.
    if ((await authorizeOutboundUrl(href)) === null) return AUTHORIZATION_DENIED
    const iconUrl = await authorizeOutboundUrl(metadata.iconUrl)
    if (iconUrl === null) return AUTHORIZATION_DENIED

    let iconSrc: string | undefined
    try {
      iconSrc = await dependencies.fetchIcon(iconUrl)
    } catch {
      // A favicon is optional; the card falls back to a globe.
    }

    // A result is usable only while its source note and editor session remain public.
    if ((await authorizeOutboundUrl(href)) === null) return AUTHORIZATION_DENIED

    return {
      kind: 'resolved',
      preview: {
        title: metadata.title,
        ...(metadata.description === null ? {} : { description: metadata.description }),
        ...(iconSrc === undefined ? {} : { iconSrc }),
      },
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
    const pageUrl = await authorizeOutboundUrl(href)
    if (pageUrl === null) return

    let pending = cache.get(href)
    if (pending === undefined) {
      pending = resolve(href, pageUrl)
      cache.set(href, pending)
    }
    const resolution = await pending
    if (resolution.kind === 'authorization-denied') {
      if (cache.get(href) === pending) cache.delete(href)
      return
    }
    return resolution.preview
  }
}
