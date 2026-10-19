import { describe, expect, it, vi } from 'vitest'
import type { LinkPreviewResolver } from '@meowdown/core'
import {
  createLinkPreviewService,
  type LinkPreviewSession,
  type NoteDocumentService,
  type parseLinkPreviewMeta,
  type WebFetchService,
  AppError,
} from '@reflect/core'
import {
  createNodeTestDatabaseService,
  createTestCoreServices,
  createTestGraphSessionService,
} from '@reflect/core/testing'

/**
 * The boundaries of the resolver pipeline that `useLinkPreview` gets from `LinkPreviewService`.
 */
interface LinkPreviewResolverDependencies {
  /**
   * Read the note's live full markdown through the open-document registry.
   */
  readonly readSource: NoteDocumentService['readExisting']
  /**
   * Fetch bounded page HTML using a privacy-authorized URL.
   */
  readonly fetchHtml: WebFetchService['fetchLinkPreviewHtml']
  /**
   * Fetch a bounded raster favicon using a privacy-authorized URL.
   */
  readonly fetchIcon: WebFetchService['fetchLinkPreviewIcon']
  /**
   * Parse and validate bounded display metadata from the fetched page.
   */
  readonly parseMetadata: typeof parseLinkPreviewMeta
}

/**
 * One editor-session resolver of a `LinkPreviewService` over `dependencies`.
 */
function createNoteLinkPreviewResolver(
  session: LinkPreviewSession,
  currentSession: () => LinkPreviewSession | null,
  dependencies: LinkPreviewResolverDependencies,
): LinkPreviewResolver {
  const { noteDocuments, privacy, webFetch } = createTestCoreServices({
    database: createNodeTestDatabaseService(),
  })
  vi.spyOn(noteDocuments, 'readExisting').mockImplementation(dependencies.readSource)
  vi.spyOn(webFetch, 'fetchLinkPreviewHtml').mockImplementation(dependencies.fetchHtml)
  vi.spyOn(webFetch, 'fetchLinkPreviewIcon').mockImplementation(dependencies.fetchIcon)
  return createLinkPreviewService({
    noteDocuments,
    privacy,
    webFetch,
    parseMetadata: dependencies.parseMetadata,
    graphSession: createTestGraphSessionService({ graph: { generation: 7 } }),
  }).createResolver(session, currentSession)
}

const session: LinkPreviewSession = {
  path: 'notes/a.md',
  graphKey: '/graph-a',
  sessionEpoch: 3,
}
const publicSource = '---\nprivate: false\n---\n# Public'
const privateSource = '---\nprivate: true\n---\n# Private'
const page = {
  html: '<title>Example title</title><meta name="description" content="Example body"><link rel="icon" href="/icon.png">',
  finalUrl: 'https://example.com/page',
}

function dependencies(
  overrides: Partial<LinkPreviewResolverDependencies> = {},
): LinkPreviewResolverDependencies {
  return {
    readSource: vi.fn().mockResolvedValue(publicSource),
    fetchHtml: vi.fn().mockResolvedValue(page),
    fetchIcon: vi.fn().mockResolvedValue('data:image/png;base64,aGVsbG8='),
    parseMetadata: vi.fn().mockReturnValue({
      title: 'Example title',
      description: 'Example body',
      iconUrl: 'https://example.com/icon.png',
    }),
    ...overrides,
  }
}

describe('createNoteLinkPreviewResolver', () => {
  it('caches successes and deduplicates concurrent requests per session', async () => {
    const deps = dependencies()
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)
    const first = resolver('https://example.com/page')
    const second = resolver('https://example.com/page')

    await expect(first).resolves.toEqual({
      title: 'Example title',
      description: 'Example body',
      iconSrc: 'data:image/png;base64,aGVsbG8=',
    })
    await expect(second).resolves.toEqual(await first)
    await expect(resolver('https://example.com/page')).resolves.toEqual(await first)
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
    expect(deps.fetchIcon).toHaveBeenCalledTimes(1)
    expect(deps.fetchIcon).toHaveBeenCalledWith('https://example.com/icon.png')
  })

  it('revalidates privacy before returning a cached preview', async () => {
    let source = publicSource
    const deps = dependencies({ readSource: vi.fn(() => Promise.resolve(source)) })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)

    await expect(resolver('https://example.com')).resolves.toMatchObject({
      title: 'Example title',
    })
    source = privateSource
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
  })

  it('does not cache an initial privacy denial', async () => {
    let source = privateSource
    const deps = dependencies({ readSource: vi.fn(() => Promise.resolve(source)) })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)

    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    source = publicSource
    await expect(resolver('https://example.com')).resolves.toMatchObject({
      title: 'Example title',
    })
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
  })

  it('does not cache a privacy denial during resolution', async () => {
    let source = publicSource
    const parseMetadata = vi
      .fn()
      .mockImplementationOnce(() => {
        source = privateSource
        return {
          title: 'Example title',
          description: 'Example body',
          iconUrl: 'https://example.com/icon.png',
        }
      })
      .mockReturnValue({
        title: 'Example title',
        description: 'Example body',
        iconUrl: 'https://example.com/icon.png',
      })
    const deps = dependencies({
      readSource: vi.fn(() => Promise.resolve(source)),
      parseMetadata,
    })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)

    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    source = publicSource
    await expect(resolver('https://example.com')).resolves.toMatchObject({
      title: 'Example title',
    })
    expect(deps.fetchHtml).toHaveBeenCalledTimes(2)
  })

  it('caches permanent failed lookups and refuses non-web destinations', async () => {
    const deps = dependencies({ fetchHtml: vi.fn().mockRejectedValue(new Error('offline')) })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    await expect(resolver('file:///etc/passwd')).resolves.toBeUndefined()
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
  })

  it('retries transient page-fetch failures', async () => {
    const fetchHtml = vi
      .fn()
      .mockRejectedValueOnce(new AppError('network', 'offline'))
      .mockResolvedValue(page)
    const deps = dependencies({ fetchHtml })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)

    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    await expect(resolver('https://example.com')).resolves.toMatchObject({
      title: 'Example title',
    })
    expect(fetchHtml).toHaveBeenCalledTimes(2)
  })

  it('shows metadata but retries after a transient favicon failure', async () => {
    const fetchIcon = vi
      .fn()
      .mockRejectedValueOnce(new AppError('network', 'offline'))
      .mockResolvedValue('data:image/png;base64,aGVsbG8=')
    const deps = dependencies({ fetchIcon })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)

    await expect(resolver('https://example.com')).resolves.toEqual({
      title: 'Example title',
      description: 'Example body',
    })
    await expect(resolver('https://example.com')).resolves.toMatchObject({
      iconSrc: 'data:image/png;base64,aGVsbG8=',
    })
    expect(deps.fetchHtml).toHaveBeenCalledTimes(2)
    expect(fetchIcon).toHaveBeenCalledTimes(2)
  })

  it('silently caches metadata parse failures', async () => {
    const deps = dependencies({
      parseMetadata: vi.fn().mockImplementation(() => {
        throw new Error('malformed page URL')
      }),
    })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
    expect(deps.fetchIcon).not.toHaveBeenCalled()
  })

  it('fails closed for private, missing, and unreadable notes', async () => {
    for (const readSource of [
      vi.fn().mockResolvedValue(privateSource),
      vi.fn().mockRejectedValue(new AppError('notFound', 'no such note')),
      vi.fn().mockRejectedValue(new Error('unreadable')),
    ]) {
      const deps = dependencies({ readSource })
      const resolver = createNoteLinkPreviewResolver(session, () => session, deps)
      await expect(resolver('https://example.com')).resolves.toBeUndefined()
      expect(deps.fetchHtml).not.toHaveBeenCalled()
      expect(deps.fetchIcon).not.toHaveBeenCalled()
    }
  })

  it.each([
    {
      checkpoint: 'after page metadata and before favicon retrieval',
      sources: [publicSource, privateSource],
      expectedIconCalls: 0,
    },
    {
      checkpoint: 'after favicon retrieval',
      sources: [publicSource, publicSource, privateSource],
      expectedIconCalls: 1,
    },
  ])('fails closed when privacy changes $checkpoint', async ({ sources, expectedIconCalls }) => {
    const readSource = vi.fn()
    for (const source of sources) readSource.mockResolvedValueOnce(source)
    const deps = dependencies({ readSource })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    expect(readSource).toHaveBeenCalledTimes(sources.length)
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
    expect(deps.fetchIcon).toHaveBeenCalledTimes(expectedIconCalls)
  })

  it('discards stale graph and editor-session work before a later request', async () => {
    let current: LinkPreviewSession | null = session
    const fetchHtml = vi.fn(() => {
      current = { ...session, graphKey: '/graph-b' }
      return Promise.resolve(page)
    })
    const deps = dependencies({ fetchHtml })
    const resolver = createNoteLinkPreviewResolver(session, () => current, deps)
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    expect(deps.fetchIcon).not.toHaveBeenCalled()
    expect(deps.readSource).toHaveBeenCalledTimes(1)
  })
})
