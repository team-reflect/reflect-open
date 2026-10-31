import { describe, expect, it, vi } from 'vitest'
import { overrideNoteFileService } from '../testing/graph.ts'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import { createNoteRowService } from '../documents/note-row-service.ts'
import type { NoteSession } from '../documents/note-session-types.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { gistBodyHash } from '../markdown/gist.ts'
import { createPrivacyService } from '../privacy/privacy-service.ts'
import {
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestHttpService,
  createTestNoteFileService,
  createTestNoteSession,
  createTestProgressPort,
  type TestHttpReply,
  createTestGithubAuthService,
} from '../testing/index.ts'
import { createGistPublishService } from './gist-publish-service.ts'
import { createGistService } from './gist-service.ts'

const GISTS_URL = 'https://api.github.com/gists'
const PUBLISHED = { id: 'g1', htmlUrl: 'https://gist.github.com/alex/g1' }
const BODY = '# A\n\nhello\n'
const PATH = 'notes/a.md'

/**
 * A note already carrying a gist block (published as `Old.md`, hash stale).
 */
const REPUBLISH_SOURCE = upsertFrontmatter(BODY, {
  gist: {
    id: 'g0',
    url: 'https://gist.github.com/alex/g0',
    file: 'Old.md',
    hash: 'feedfacefeedface',
  },
})

interface SetupOptions {
  /**
   * The note on disk; `null` leaves the file missing. Defaults to {@link BODY}.
   */
  source?: string | null
  /**
   * The stored GitHub token. Defaults to `'tok'`.
   */
  token?: string | null
  /**
   * An open session of the note.
   */
  session?: NoteSession
}

function setup(options?: SetupOptions) {
  const source = options?.source === undefined ? BODY : options.source
  const token = options?.token === undefined ? 'tok' : options.token

  const http = createTestHttpService()
  const created = { id: PUBLISHED.id, html_url: PUBLISHED.htmlUrl }
  http.on('POST', GISTS_URL, { status: 201, json: created })
  http.on('PATCH', (url) => url.startsWith(`${GISTS_URL}/`), { status: 200, json: created })
  http.on('DELETE', (url) => url.startsWith(`${GISTS_URL}/`), { status: 204 })

  const files = createTestNoteFileService(source === null ? {} : { files: { [PATH]: source } })
  let writeFailure: Error | null = null
  const noteFile = overrideNoteFileService(files, {
    async write(...args) {
      if (writeFailure !== null) {
        const error = writeFailure
        writeFailure = null
        throw error
      }
      return await files.write(...args)
    },
  })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  if (options?.session !== undefined) {
    openDocuments.register({ session: options.session })
  }
  const tokenReads = { count: 0 }
  const graph = createTestGraphSessionService({ graph: { generation: 3 } })
  const noteRows = createNoteRowService({ graphSession: graph })
  const progress = createTestProgressPort()
  const githubAuth = createTestGithubAuthService()
  vi.spyOn(githubAuth, 'getToken').mockImplementation(() => {
    tokenReads.count += 1
    return Promise.resolve(token)
  })
  const service = createGistPublishService({
    gists: createGistService({ http }),
    githubAuth,
    noteDocuments: createNoteDocumentService({
      openDocuments,
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
    }),
    noteRows,
    privacy: createPrivacyService({
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    }),
    progress,
    graphSession: graph,
  })

  return {
    service,
    graph,
    http,
    files,
    noteRows,
    progress,
    tokenReads,
    /**
     * Make the next disk write reject with `error`.
     */
    failNextWrite: (error: Error): void => {
      writeFailure = error
    },
    /**
     * Answer every gist request of `method` with `reply`.
     */
    reply: (method: string, reply: TestHttpReply): void => {
      http.on(method, (url) => url.startsWith(GISTS_URL), reply)
    },
    /**
     * The gist requests sent with `method`, each with its JSON body.
     */
    sent: (method: string) => {
      return http
        .requests()
        .filter((request) => request.method === method)
        .map((request) => ({
          url: request.url,
          token: request.headers.get('Authorization'),
          body: request.body === null ? null : (JSON.parse(request.body) as unknown),
        }))
    },
  }
}

describe('GistPublishService.publish', () => {
  it('creates a secret gist for a fresh note and records it in frontmatter', async () => {
    const { service, files, sent } = setup()
    await expect(service.publish(PATH)).resolves.toEqual({
      url: PUBLISHED.htmlUrl,
      stale: false,
    })

    expect(sent('POST')).toEqual([
      {
        url: GISTS_URL,
        token: 'Bearer tok',
        body: { public: false, files: { 'A.md': { content: BODY } } },
      },
    ])
    const gist = { id: 'g1', url: PUBLISHED.htmlUrl, file: 'A.md', hash: gistBodyHash(BODY) }
    expect(files.writes()).toEqual([
      { path: PATH, contents: upsertFrontmatter(BODY, { gist }), generation: 3 },
    ])
  })

  it('republishes to the same gist, addressing the file by its previous name', async () => {
    const { service, sent } = setup({ source: REPUBLISH_SOURCE })
    await expect(service.publish(PATH)).resolves.toEqual({
      url: PUBLISHED.htmlUrl,
      stale: false,
    })

    expect(sent('PATCH')).toEqual([
      {
        url: `${GISTS_URL}/g0`,
        token: 'Bearer tok',
        body: { files: { 'Old.md': { filename: 'A.md', content: BODY } } },
      },
    ])
    expect(sent('POST')).toEqual([])
  })

  it('falls back to creating a fresh gist when the old one is gone (update → null)', async () => {
    const { service, files, reply, sent } = setup({ source: REPUBLISH_SOURCE })
    reply('PATCH', { status: 404 })
    await expect(service.publish(PATH)).resolves.toEqual({
      url: PUBLISHED.htmlUrl,
      stale: false,
    })

    expect(sent('POST')).toHaveLength(1)
    expect(files.getWrites(PATH)[0]).toContain('id: g1')
  })

  it('routes the frontmatter write through the live session when the note is open', async () => {
    const session = createTestNoteSession({ path: PATH, content: BODY })
    const { service, files } = setup({ source: null, session })
    await expect(service.publish(PATH)).resolves.toEqual({
      url: PUBLISHED.htmlUrl,
      stale: false,
    })

    expect(session.getCalls('commitFrontmatter')).toEqual([
      [{ gist: { id: 'g1', url: PUBLISHED.htmlUrl, file: 'A.md', hash: gistBodyHash(BODY) } }],
    ])
    expect(files.writes()).toEqual([])
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const session = createTestNoteSession({ path: PATH, content: BODY, accepts: false })
    const { service, files } = setup({ session })
    await expect(service.publish(PATH)).resolves.toEqual({
      url: PUBLISHED.htmlUrl,
      stale: false,
    })
    expect(files.writes()).toHaveLength(1)
  })

  it('reads disk, not the empty buffer, when the open session is still loading', async () => {
    // liveContent === null means the buffer isn't the truth yet: publish must
    // read the real body from disk, not publish an empty gist.
    const session = createTestNoteSession({ path: PATH, loaded: false, accepts: false })
    const { service, files, sent } = setup({ session })

    await expect(service.publish(PATH)).resolves.toEqual({
      url: PUBLISHED.htmlUrl,
      stale: false,
    })

    expect(sent('POST').map((request) => request.body)).toEqual([
      { public: false, files: { 'A.md': { content: BODY } } },
    ])
    expect(files.writes()).toHaveLength(1)
  })

  it('refuses to publish a private note before anything leaves the device', async () => {
    const { service, http, progress, tokenReads } = setup({
      source: '---\nprivate: true\n---\nsecret',
    })
    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Publishing gist')).toMatchObject({
      status: 'failed',
      message: `"${PATH}" is marked private and cannot be sent to an external service`,
    })
    expect(tokenReads.count).toBe(0)
    expect(http.requests()).toEqual([])
  })

  it('refuses an empty note', async () => {
    const { service, http, progress } = setup({ source: '---\npinned: true\n---\n' })
    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Publishing gist')).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/empty/i) as string,
    })
    expect(http.requests()).toEqual([])
  })

  it('asks for a GitHub connection when no credential is stored', async () => {
    const { service, progress } = setup({ token: null })
    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Publishing gist')).toMatchObject({
      status: 'failed',
      message: 'Connect GitHub in Settings to publish gists',
    })
  })

  it('refuses invalid frontmatter before anything reaches GitHub (the record write would refuse)', async () => {
    const { service, http, progress } = setup({ source: '---\nfoo: [unclosed\n---\nbody' })
    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Publishing gist')).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/invalid frontmatter/i) as string,
    })
    expect(http.requests()).toEqual([])
  })

  it('deletes a freshly created gist when recording it locally fails (no orphans)', async () => {
    const { service, failNextWrite, progress, sent } = setup()
    failNextWrite(new Error('disk on fire'))
    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Publishing gist')).toMatchObject({
      status: 'failed',
      message: 'disk on fire',
    })
    expect(sent('DELETE')).toEqual([{ url: `${GISTS_URL}/g1`, token: 'Bearer tok', body: null }])
  })

  it('never deletes the existing gist when recording a republish fails (shared links survive)', async () => {
    const { service, failNextWrite, progress, reply, sent } = setup({
      source: REPUBLISH_SOURCE,
    })
    reply('PATCH', {
      status: 200,
      json: { id: 'g0', html_url: 'https://gist.github.com/alex/g0' },
    })
    failNextWrite(new Error('disk on fire'))
    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Publishing gist')).toMatchObject({
      status: 'failed',
      message: 'disk on fire',
    })
    expect(sent('DELETE')).toEqual([])
  })

  it('still surfaces the record failure when the compensating delete also fails', async () => {
    const { service, failNextWrite, progress, reply, sent } = setup()
    failNextWrite(new Error('disk on fire'))
    reply('DELETE', { status: 500 })
    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Publishing gist')).toMatchObject({
      status: 'failed',
      message: 'disk on fire',
    })
    expect(sent('DELETE')).toHaveLength(1)
  })

  it('publishes and resolves the gist url', async () => {
    const { service, progress } = setup()
    await expect(service.publish(PATH)).resolves.toEqual({
      url: PUBLISHED.htmlUrl,
      stale: false,
    })

    expect(progress.started()).toMatchObject([{ label: 'Publishing gist', ended: true }])
    expect(progress.getAll()).toEqual([])
  })

  it('records the published url in the optimistic overlay, stamped with the generation', async () => {
    const { service, noteRows } = setup()
    await service.publish(PATH)

    expect(noteRows.getOverlay(PATH)).toMatchObject({
      gistUrl: PUBLISHED.htmlUrl,
      gistStale: false,
    })
    // Stamped with the publishing generation — a reader on another graph won't see it.
    expect(noteRows.getOverlaysOn(4).get(PATH)).toBeUndefined()
  })

  it('leaves no overlay when the publish failed', async () => {
    const { service, noteRows } = setup({ token: null })
    await service.publish(PATH)

    expect(noteRows.getOverlay(PATH)).toBeNull()
  })

  it('surfaces failures and resolves null', async () => {
    const { service, progress } = setup({ token: null })
    await expect(service.publish(PATH)).resolves.toBeNull()

    expect(progress.snapshot()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        message: expect.stringMatching(/connect github/i) as string,
      }),
    )
  })
})

describe('GistPublishService.unpublish', () => {
  it('deletes the existing gist and removes the frontmatter block', async () => {
    const { service, files, sent } = setup({ source: REPUBLISH_SOURCE })
    await expect(service.unpublish(PATH)).resolves.toEqual({ url: null, stale: false })

    expect(sent('DELETE')).toEqual([{ url: `${GISTS_URL}/g0`, token: 'Bearer tok', body: null }])
    expect(files.writes()).toEqual([{ path: PATH, contents: BODY, generation: 3 }])
  })

  it('does not delete the remote gist when clearing local frontmatter fails', async () => {
    const { service, failNextWrite, http, progress } = setup({ source: REPUBLISH_SOURCE })
    failNextWrite(new Error('disk on fire'))

    await expect(service.unpublish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Unpublishing gist')).toMatchObject({
      status: 'failed',
      message: 'disk on fire',
    })

    expect(http.requests()).toEqual([])
  })

  it('restores local gist frontmatter when the remote delete fails', async () => {
    const { service, files, progress, reply } = setup({ source: REPUBLISH_SOURCE })
    reply('DELETE', { status: 500 })

    await expect(service.unpublish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Unpublishing gist')).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('deleting the gist failed') as string,
    })

    expect(files.writes()).toEqual([
      { path: PATH, contents: BODY, generation: 3 },
      { path: PATH, contents: REPUBLISH_SOURCE, generation: 3 },
    ])
  })

  it('routes the gist removal through the live session when the note is open', async () => {
    const session = createTestNoteSession({ path: PATH, content: REPUBLISH_SOURCE })
    const { service, files } = setup({ source: null, session })

    await expect(service.unpublish(PATH)).resolves.toEqual({ url: null, stale: false })

    expect(session.getCalls('commitFrontmatter')).toEqual([[{ gist: false }]])
    expect(files.writes()).toEqual([])
  })

  it('is a no-op when the note has no gist block', async () => {
    const { service, files, http } = setup()

    await expect(service.unpublish(PATH)).resolves.toEqual({ url: null, stale: false })

    expect(http.requests()).toEqual([])
    expect(files.writes()).toEqual([])
  })

  it('asks for a GitHub connection before deleting the gist', async () => {
    const { service, http, progress } = setup({ source: REPUBLISH_SOURCE, token: null })

    await expect(service.unpublish(PATH)).resolves.toBeNull()
    expect(progress.findByLabel('Unpublishing gist')).toMatchObject({
      status: 'failed',
      message: 'Connect GitHub in Settings to unpublish gists',
    })
    expect(http.requests()).toEqual([])
  })

  it('unpublishes and clears the published url in the optimistic overlay', async () => {
    const { service, noteRows, progress } = setup({ source: REPUBLISH_SOURCE })

    await expect(service.unpublish(PATH)).resolves.toEqual({ url: null, stale: false })

    expect(progress.started()).toMatchObject([{ label: 'Unpublishing gist', ended: true }])
    expect(progress.getAll()).toEqual([])
    expect(noteRows.getOverlay(PATH)).toMatchObject({ gistUrl: null, gistStale: false })
  })

  it('surfaces failures and leaves no overlay', async () => {
    const { service, noteRows, progress } = setup({ source: REPUBLISH_SOURCE, token: null })

    await expect(service.unpublish(PATH)).resolves.toBeNull()

    expect(progress.snapshot()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        message: expect.stringMatching(/connect github/i) as string,
      }),
    )
    expect(noteRows.getOverlay(PATH)).toBeNull()
  })

  it('blocks publish or update while an unpublish is in flight for the same note', async () => {
    const { service, progress, reply, sent } = setup({ source: REPUBLISH_SOURCE })
    const deleteStarted = Promise.withResolvers<void>()
    const pendingDelete = Promise.withResolvers<Response>()
    reply('DELETE', () => {
      deleteStarted.resolve()
      return pendingDelete.promise
    })

    const unpublish = service.unpublish(PATH)
    await deleteStarted.promise

    await expect(service.publish(PATH)).resolves.toBeNull()
    expect(sent('POST')).toEqual([])
    expect(sent('PATCH')).toEqual([])
    expect(progress.snapshot()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        message: expect.stringMatching(/current gist operation/i) as string,
      }),
    )

    pendingDelete.resolve(new Response(null, { status: 204 }))
    await expect(unpublish).resolves.toEqual({ url: null, stale: false })
  })
})

describe('with no graph open', () => {
  it('publishes and unpublishes nothing and resolves null', async () => {
    const { service, graph, http, progress } = setup({ source: REPUBLISH_SOURCE })
    graph.setGraph(null)

    await expect(service.publish(PATH)).resolves.toBeNull()
    await expect(service.unpublish(PATH)).resolves.toBeNull()

    expect(http.requests()).toEqual([])
    expect(progress.getAll()).toEqual([])
  })
})
