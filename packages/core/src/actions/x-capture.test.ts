import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors'
import { parseNote } from '../markdown/extract'
import { splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import type { XEnvelope } from './capture-envelope'
import {
  addSpool,
  createNoteMock,
  drain,
  envelope,
  files,
  getSecretMock,
  inboxRemoveMock,
  jsonFetchMock,
  mediaFetchMock,
  reconcile,
  spool,
  wireCaptureMocks,
  writeAssetMock,
  writeNoteMock,
} from './capture-harness'

vi.mock('../graph/commands', () => ({
  captureInboxList: vi.fn(),
  captureInboxRead: vi.fn(),
  captureInboxReject: vi.fn(),
  captureInboxRemove: vi.fn(),
  captureLinkPreview: vi.fn(),
  captureJsonFetch: vi.fn(),
  captureMediaFetch: vi.fn(),
  createNoteIfAbsent: vi.fn(),
  listFiles: vi.fn(),
  promoteCaptureScreenshot: vi.fn(),
  readAsset: vi.fn(),
  readNote: vi.fn(),
  writeAsset: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('./meta-scrape', () => ({ scrapePageMeta: vi.fn() }))
vi.mock('../ai/describe-page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/describe-page')>()),
  describePage: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({ getSecret: vi.fn() }))
vi.mock('./backlink-target', () => ({ ensureBacklinkTarget: vi.fn(async () => 'Links') }))

const FIRST_ID = '39c287a8-1f4e-437f-a96b-1bb8554e7989'
const SECOND_ID = '39c287a8-1f4e-437f-a96b-1bb8554e7990'
const DAY = 'daily/2026-09-07.md'
const AUTO_PATH = 'notes/capture-x-2026-09-07-1234567890123456789.md'
const MANUAL_PATH = `notes/capture-x-2026-09-07-manual-${FIRST_ID}.md`
const PHOTO = 'https://pbs.twimg.com/media/first.jpg'
const SECOND_PHOTO = 'https://pbs.twimg.com/media/second.jpg'

function capture(overrides: Partial<XEnvelope> = {}): XEnvelope {
  return {
    version: 2,
    id: FIRST_ID,
    url: 'https://x.com/i/status/1234567890123456789',
    title: 'X',
    capturedAt: '2026-09-07T01:00:00Z',
    source: 'extension',
    x: { trigger: 'manual', day: '2026-09-07', post: { id: '1234567890123456789' } },
    ...overrides,
  }
}

async function save(captured: XEnvelope = capture()): Promise<void> {
  addSpool(captured, { screenshot: false })
  expect((await drain()).stopped).toBeNull()
}

function source(path = MANUAL_PATH): string {
  return files.get(path) ?? ''
}

beforeEach(wireCaptureMocks)

describe('X capture snapshots', () => {
  it('repairs a failed Daily write on replay without losing arbitrary annotation Markdown', async () => {
    const note = 'First paragraph\n\n## Note\n\nSecond paragraph\n\n## Screenshot\n\nLast paragraph'
    addSpool(capture({ note }), { screenshot: false })
    writeNoteMock.mockRejectedValueOnce(new ReflectError('io', 'disk full'))
    expect((await drain()).stopped?.reason).toBe('io')
    expect(source()).toContain(note)
    expect(spool.has(`${FIRST_ID}.json`)).toBe(true)

    await drain()
    await reconcile()

    expect([...files.keys()].filter((path) => path.startsWith('notes/capture-x-'))).toEqual([
      MANUAL_PATH,
    ])
    expect(
      parseNote({ path: DAY, source: source(DAY) }).wikiLinks.filter((link) =>
        link.target.startsWith('capture-x-'),
      ),
    ).toHaveLength(1)
    expect(source()).toContain(note)
    expect(source()).toContain('captureStatus: done')
    expect(source()).not.toContain('captureInput:')
    expect(spool.size).toBe(0)
  })

  it('keeps the first automatic snapshot while two manual saves remain distinct', async () => {
    const automatic = capture({
      x: {
        trigger: 'bookmark',
        day: '2026-09-07',
        post: { id: '1234567890123456789', text: { value: 'First snapshot', complete: true } },
      },
    })
    await save(automatic)
    const original = upsertFrontmatter(source(AUTO_PATH), { private: true, project: 'Keep this' })
    files.set(AUTO_PATH, original)
    await save({
      ...automatic,
      id: SECOND_ID,
      x: {
        ...automatic.x,
        trigger: 'like',
        post: { ...automatic.x.post, text: { value: 'Later snapshot', complete: true } },
      },
    })
    expect(source(AUTO_PATH)).toBe(original)
    await save(capture())
    await save(capture({ id: SECOND_ID }))
    expect([...files.keys()].filter((path) => path.startsWith('notes/capture-x-'))).toHaveLength(3)
    await reconcile()
    expect(source(AUTO_PATH)).toContain('project: Keep this')
    expect(source(AUTO_PATH)).not.toContain('Later snapshot')
  })

  it('handles a no-clobber collision using the winner and never adopts an unrelated note', async () => {
    await save()
    const winner = source()
    files.clear()
    createNoteMock.mockImplementationOnce(async (path) => {
      files.set(path, winner)
      return { kind: 'collision' }
    })
    await save(capture({ note: 'Losing input' }))
    expect(source()).toBe(winner)
    files.set(MANUAL_PATH, '# My own note\n')
    addSpool(capture(), { screenshot: false })
    expect((await drain()).stopped?.reason).toBe('io')
    expect(source()).toBe('# My own note\n')
    expect(spool.has(`${FIRST_ID}.json`)).toBe(true)
  })

  it('keeps the envelope when screenshot cleanup fails and replays the completed save', async () => {
    addSpool(capture())
    inboxRemoveMock.mockRejectedValueOnce(new ReflectError('io', 'cannot remove screenshot'))
    expect((await drain()).stopped?.reason).toBe('io')
    expect(spool.has(`${FIRST_ID}.json`)).toBe(true)
    await drain()
    expect(spool.size).toBe(0)
    expect(source()).toContain(`assets/capture-${FIRST_ID}.jpg`)
    expect(
      parseNote({ path: DAY, source: source(DAY) }).wikiLinks.filter((link) =>
        link.target.startsWith('capture-x-'),
      ),
    ).toHaveLength(1)
  })

  it('does not let a legacy URL capture refresh an X note', async () => {
    await save()
    const original = source()
    addSpool(
      envelope({
        url: 'https://x.com/i/status/1234567890123456789',
        capturedAt: new Date(2026, 8, 7).toISOString(),
      }),
      { screenshot: false },
    )
    await drain()
    expect(source()).toBe(original)
    expect([...files.keys()].filter((path) => path.startsWith('notes/capture-'))).toHaveLength(2)
  })

  it('defers dirty buffers and copies Daily privacy before any external request', async () => {
    addSpool(capture(), { screenshot: false })
    await drain({ isNoteDirty: (path) => path === DAY })
    expect(files.has(MANUAL_PATH)).toBe(false)
    expect(spool.size).toBe(1)
    files.set(DAY, '---\nprivate: true\n---\n# Private day\n')
    await drain()
    await reconcile()
    expect(source()).toContain('private: true')
    expect(source()).toContain('captureStatus: skipped')
    expect(source()).not.toContain('captureInput:')
    expect(jsonFetchMock).not.toHaveBeenCalled()
  })

  it.each(['body', 'private', 'dirty'] as const)(
    'respects %s ownership before enrichment',
    async (change) => {
      await save()
      const original = upsertFrontmatter(source(), { project: 'Retain' })
      files.set(
        MANUAL_PATH,
        change === 'private'
          ? upsertFrontmatter(original, { private: true })
          : change === 'body'
            ? `${original}\nUser addition\n`
            : original,
      )
      const body = splitFrontmatter(source()).body
      await reconcile({ isNoteDirty: () => change === 'dirty' })
      expect(splitFrontmatter(source()).body).toBe(body)
      expect(source()).toContain('project: Retain')
      expect(source()).toContain(`captureStatus: ${change === 'dirty' ? 'pending' : 'skipped'}`)
      expect(jsonFetchMock).not.toHaveBeenCalled()
    },
  )

  it('keeps complete page text, local images and custom metadata without an AI key', async () => {
    await save(
      capture({
        note: '## Note\n\nKeep my Markdown',
        x: {
          trigger: 'manual',
          day: '2026-09-07',
          post: {
            id: '1234567890123456789',
            text: { value: 'The complete text from the page.', complete: true },
            images: [{ url: PHOTO }],
          },
        },
      }),
    )
    files.set(MANUAL_PATH, upsertFrontmatter(source(), { project: 'Retain' }))
    jsonFetchMock.mockResolvedValue(
      JSON.stringify({
        id_str: '1234567890123456789',
        text: 'Short preview',
        note_tweet: { id: 'long-post' },
        user: { name: 'Author', screen_name: 'author' },
      }),
    )
    getSecretMock.mockRejectedValue(new ReflectError('auth', 'keychain locked'))
    expect((await reconcile()).enriched).toBe(1)
    expect(source()).toContain('The complete text from the page\\.')
    expect(source()).not.toContain('Short preview')
    expect(source()).toContain(`![Post image](assets/capture-${FIRST_ID}-1.jpg)`)
    expect(source()).toContain('## Note\n\nKeep my Markdown')
    expect(source()).toContain('project: Retain')
    expect(source()).not.toContain('captureInput:')
    expect(getSecretMock).not.toHaveBeenCalled()
    expect(source(DAY)).toContain('|Author on X]]')
  })

  it('keeps media unavailable as a link and cannot turn external text into an image or HTML', async () => {
    await save(
      capture({
        x: {
          trigger: 'manual',
          day: '2026-09-07',
          post: {
            id: '1234567890123456789',
            text: {
              value:
                '![injected](https://example.com/tracker.jpg)\n<img src="https://example.com/another.jpg">\n\n## A heading',
              complete: true,
            },
            images: [{ url: PHOTO }],
          },
        },
      }),
    )
    mediaFetchMock.mockRejectedValue(new ReflectError('notFound', 'image deleted'))
    expect((await reconcile()).enriched).toBe(1)
    const parsed = parseNote({ path: MANUAL_PATH, source: source() })
    expect(parsed.assets).toEqual([])
    expect(parsed.headings.map((heading) => heading.text)).toEqual(['X post 1234567890123456789'])
    expect(source()).toContain(`[Image source](<${PHOTO}>)`)
    expect(writeAssetMock).not.toHaveBeenCalled()
  })

  it('does not request another image after privacy changes during a failed download', async () => {
    await save(
      capture({
        x: {
          trigger: 'manual',
          day: '2026-09-07',
          post: { id: '1234567890123456789', images: [{ url: PHOTO }, { url: SECOND_PHOTO }] },
        },
      }),
    )
    const originalBody = splitFrontmatter(source()).body
    mediaFetchMock.mockImplementationOnce(async () => {
      files.set(MANUAL_PATH, upsertFrontmatter(source(), { private: true }))
      throw new ReflectError('notFound', 'gone')
    })
    await reconcile()
    expect(mediaFetchMock).toHaveBeenCalledTimes(1)
    expect(splitFrontmatter(source()).body).toBe(originalBody)
    expect(source()).toContain('captureStatus: skipped')
    expect(source()).toContain('private: true')
    expect(writeAssetMock).not.toHaveBeenCalled()
  })

  it.each(['network', 'asset'] as const)(
    'retries %s failures without pretending the note completed',
    async (failure) => {
      await save(
        capture({
          x: {
            trigger: 'manual',
            day: '2026-09-07',
            post: { id: '1234567890123456789', images: [{ url: PHOTO }] },
          },
        }),
      )
      if (failure === 'network')
        jsonFetchMock.mockRejectedValueOnce(new ReflectError('network', 'offline'))
      else writeAssetMock.mockRejectedValueOnce(new ReflectError('io', 'disk full'))
      expect((await reconcile()).stopped?.reason).toBe(failure === 'network' ? 'network' : 'io')
      expect(source()).toContain('captureStatus: pending')
      expect(source()).toContain('captureInput:')
      expect((await reconcile()).enriched).toBe(1)
      expect(source()).toContain('captureStatus: done')
      expect(source()).toContain(`![Post image](assets/capture-${FIRST_ID}-1.jpg)`)
    },
  )

  it('finishes a prepared retitle after restart without fetching the post again', async () => {
    await save()
    jsonFetchMock.mockResolvedValue(
      JSON.stringify({
        id_str: '1234567890123456789',
        user: { name: 'New author', screen_name: 'new' },
      }),
    )
    writeNoteMock
      .mockImplementationOnce(async (path, contents) => {
        files.set(path, contents)
      })
      .mockRejectedValueOnce(new ReflectError('io', 'Daily write failed'))
    expect((await reconcile()).stopped?.reason).toBe('io')
    expect(source()).toContain('captureInput:')
    expect(source()).toContain('captureFinalizeStatus: done')
    jsonFetchMock.mockClear()
    expect((await reconcile()).enriched).toBe(1)
    expect(source()).not.toContain('captureInput:')
    expect(source()).not.toContain('captureFinalizeStatus:')
    expect(source(DAY)).toContain('|New author on X]]')
    expect(jsonFetchMock).not.toHaveBeenCalled()
  })

  it.each(['kind', 'input'] as const)(
    'does not send damaged X %s metadata through ordinary AI enrichment',
    async (field) => {
      await save(capture({ note: 'Keep this annotation' }))
      files.set(
        MANUAL_PATH,
        upsertFrontmatter(
          source(),
          field === 'kind' ? { captureKind: undefined } : { captureInput: { version: 99 } },
        ),
      )
      const original = source()
      expect((await reconcile()).stopped?.reason).toBe('parse')
      expect(source()).toBe(original)
      expect(jsonFetchMock).not.toHaveBeenCalled()
      expect(getSecretMock).not.toHaveBeenCalled()
    },
  )
})
