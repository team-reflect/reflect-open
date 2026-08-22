import { describe, expect, it, vi } from 'vitest'
import {
  createNoteLinkPreviewResolver,
  type LinkPreviewResolverDependencies,
  type LinkPreviewSession,
} from './link-preview-resolver'

const session: LinkPreviewSession = {
  path: 'notes/a.md',
  generation: 7,
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

    expect(first).toBe(second)
    await expect(first).resolves.toEqual({
      title: 'Example title',
      description: 'Example body',
      iconSrc: 'data:image/png;base64,aGVsbG8=',
    })
    await expect(resolver('https://example.com/page')).resolves.toEqual(await first)
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
    expect(deps.fetchIcon).toHaveBeenCalledTimes(1)
    expect(deps.fetchIcon).toHaveBeenCalledWith('https://example.com/icon.png')
  })

  it('caches failed lookups and refuses non-web destinations', async () => {
    const deps = dependencies({ fetchHtml: vi.fn().mockRejectedValue(new Error('offline')) })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    await expect(resolver('file:///etc/passwd')).resolves.toBeUndefined()
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
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
      vi.fn().mockRejectedValue({ kind: 'notFound' }),
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
      checkpoint: 'after page metadata',
      sources: [publicSource, privateSource],
      expectedIconCalls: 0,
    },
    {
      checkpoint: 'immediately before favicon retrieval',
      sources: [publicSource, publicSource, privateSource],
      expectedIconCalls: 0,
    },
    {
      checkpoint: 'after favicon retrieval',
      sources: [publicSource, publicSource, publicSource, privateSource],
      expectedIconCalls: 1,
    },
  ])('fails closed when privacy changes $checkpoint', async ({ sources, expectedIconCalls }) => {
    const readSource = vi.fn()
    for (const source of sources) readSource.mockResolvedValueOnce(source)
    const deps = dependencies({ readSource })
    const resolver = createNoteLinkPreviewResolver(session, () => session, deps)
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    expect(deps.fetchHtml).toHaveBeenCalledTimes(1)
    expect(deps.fetchIcon).toHaveBeenCalledTimes(expectedIconCalls)
  })

  it('discards stale graph and editor-session work before a later request', async () => {
    let current: LinkPreviewSession | null = session
    const fetchHtml = vi.fn(async () => {
      current = { ...session, graphKey: '/graph-b' }
      return page
    })
    const deps = dependencies({ fetchHtml })
    const resolver = createNoteLinkPreviewResolver(session, () => current, deps)
    await expect(resolver('https://example.com')).resolves.toBeUndefined()
    expect(deps.fetchIcon).not.toHaveBeenCalled()
    expect(deps.readSource).toHaveBeenCalledTimes(1)
  })
})
