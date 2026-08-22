import { useLayoutEffect, useMemo, useRef } from 'react'
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
  const cache = new Map<string, Promise<LinkPreview | undefined>>()

  async function privacyCheckedHref(href: string): Promise<CloudSafe<string> | null> {
    if (!sameSession(currentSession(), session)) return null
    try {
      const source = await dependencies.readSource(session.path, session.generation)
      if (!sameSession(currentSession(), session)) return null
      const frontmatter = parseFrontmatter(splitFrontmatter(source).raw).data
      return cloudSafeLinkHref({ path: session.path, isPrivate: frontmatter.private }, href)
    } catch {
      return null
    }
  }

  async function resolve(href: string): Promise<LinkPreview | undefined> {
    try {
      const url = new URL(href)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    } catch {
      return
    }
    const initialHref = await privacyCheckedHref(href)
    if (initialHref === null) return

    let page
    try {
      page = await dependencies.fetchHtml(initialHref)
    } catch {
      return
    }
    let metadata
    try {
      metadata = dependencies.parseMetadata(page.html, page.finalUrl)
    } catch {
      return
    }
    if ((await privacyCheckedHref(href)) === null || metadata === null) return
    if ((await privacyCheckedHref(href)) === null) return

    let iconSrc: string | null = null
    try {
      iconSrc = await dependencies.fetchIcon(metadata.iconUrl)
    } catch {
      // A favicon is optional; the card falls back to a globe.
    }
    if ((await privacyCheckedHref(href)) === null) return

    return {
      title: metadata.title,
      ...(metadata.description === null ? {} : { description: metadata.description }),
      ...(iconSrc === null ? {} : { iconSrc }),
    }
  }

  return (href) => {
    const cached = cache.get(href)
    if (cached !== undefined) return cached
    const pending = resolve(href)
    cache.set(href, pending)
    return pending
  }
}

/** A privacy-gated, note-scoped link-preview resolver for one editor session. */
export function useLinkPreview(
  session: LinkPreviewSession | null,
): LinkPreviewResolver | undefined {
  const currentSessionRef = useRef<LinkPreviewSession | null>(session)
  useLayoutEffect(() => {
    currentSessionRef.current = session
    return () => {
      currentSessionRef.current = null
    }
  }, [session])

  return useMemo(() => {
    if (session === null) return
    return createNoteLinkPreviewResolver(session, () => currentSessionRef.current)
  }, [session])
}
