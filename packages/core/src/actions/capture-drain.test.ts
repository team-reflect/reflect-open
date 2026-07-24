import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addSpool,
  CAPTURED_AT,
  DAILY,
  describeMock,
  drain,
  envelope,
  files,
  IDENTITY,
  inboxRemoveMock,
  promoteMock,
  rejected,
  scrapeMock,
  spool,
  wireCaptureMocks,
  writeNoteMock,
} from './capture-harness'
import type { TextCaptureEnvelope } from './capture-envelope'

const ensureBacklinkTargetMock = vi.hoisted(() => vi.fn())

vi.mock('../graph/commands', () => ({
  captureInboxList: vi.fn(),
  captureInboxRead: vi.fn(),
  captureInboxReject: vi.fn(),
  captureInboxRemove: vi.fn(),
  captureLinkPreview: vi.fn(),
  listFiles: vi.fn(),
  promoteCaptureScreenshot: vi.fn(),
  readAsset: vi.fn(),
  readNote: vi.fn(),
  writeAsset: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('./meta-scrape', () => ({
  scrapePageMeta: vi.fn(),
}))
vi.mock('../ai/describe-page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/describe-page')>()),
  describePage: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))
vi.mock('./backlink-target', () => ({
  ensureBacklinkTarget: ensureBacklinkTargetMock,
}))

beforeEach(() => {
  wireCaptureMocks()
  ensureBacklinkTargetMock.mockResolvedValue('Links')
})

describe('drainCaptureInbox', () => {
  it('writes the capture note, daily entry, and asset — then removes the spool', async () => {
    addSpool(envelope({ selection: 'quoted text', note: 'check later' }))

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    expect(promoteMock).toHaveBeenCalledWith(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg',
      IDENTITY.assetPath,
      1600,
      3,
    )
    const note = files.get(IDENTITY.notePath)
    expect(note).toContain('captureUrl: https://example.com/article')
    expect(note).toContain('captureStatus: pending')
    expect(note).toContain('captureScreenshot: assets/capture-2026-06-11-153022-845-7c9e.jpg')
    expect(note).toContain('# An article')
    expect(note).toContain('- URL: https://example.com/article')
    expect(note).toContain('- Type: #link')
    expect(note).not.toContain('Highlights')
    expect(note).toContain('## Note\n\ncheck later')
    expect(note).toContain('## Selection\n\nquoted text')
    expect(note).toContain(`## Screenshot\n\n![An article](${IDENTITY.assetPath})`)

    const daily = files.get(DAILY)
    expect(daily).toContain('## [[Links]]')
    expect(daily).toContain('- [[capture-2026-06-11-153022-845-7c9e|An article]]')
    expect(ensureBacklinkTargetMock).toHaveBeenCalledWith('Links', 3)
    expect(spool.size).toBe(0)
  })

  it('writes extracted page text into the capture note', async () => {
    addSpool(envelope({ contentText: 'First paragraph.\n\nSecond paragraph.' }), {
      screenshot: false,
    })

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = files.get(IDENTITY.notePath)
    expect(note).toContain(
      '## Page Text\n\n<!-- reflect-capture-page-text:start -->\nFirst paragraph.\n\nSecond paragraph.\n<!-- reflect-capture-page-text:end -->',
    )
  })

  it('writes an iOS share capture with its in-page description into the raw save', async () => {
    addSpool(
      envelope({ source: 'ios-share', metaDescription: '  A page\nabout examples.  ' }),
      { screenshot: false },
    )

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = files.get(IDENTITY.notePath)
    expect(note).toContain('captureSource: ios-share')
    // Whitespace-folded onto the one metadata line, right where enrichment
    // will replace it in place.
    expect(note).toContain('- Type: #link\n- Description: A page about examples.')
    expect(note).toContain('captureStatus: pending')
  })

  it('removes the spool only after the note and daily entry are written', async () => {
    addSpool(envelope())
    await drain()
    const lastWrite = Math.max(...writeNoteMock.mock.invocationCallOrder)
    const firstRemove = Math.min(...inboxRemoveMock.mock.invocationCallOrder)
    expect(firstRemove).toBeGreaterThan(lastWrite)
  })

  it('drains a batch that arrived while the app was closed, oldest first', async () => {
    addSpool(envelope({ id: '00000000-0000-4000-8000-000000000002', url: 'https://b.com' }), {
      modifiedMs: 200,
    })
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        url: 'https://a.com',
        capturedAt: new Date(2026, 5, 11, 9, 0, 0, 0).toISOString(),
      }),
      { modifiedMs: 100 },
    )

    const outcome = await drain()

    expect(outcome.drained).toBe(2)
    const daily = files.get(DAILY) ?? ''
    expect(daily.indexOf('capture-2026-06-11-090000-000')).toBeLessThan(
      daily.indexOf('capture-2026-06-11-153022-845'),
    )
    expect(spool.size).toBe(0)
  })

  it('upgrades the existing plain Links section without duplicating it', async () => {
    files.set(DAILY, '# plans\n\n## Links\n\n[[capture-2026-06-11-090000-000-0000|Old]]\n')
    addSpool(envelope())

    await drain()

    const daily = files.get(DAILY) ?? ''
    expect(daily.match(/## \[\[Links\]\]/g)).toHaveLength(1)
    expect(daily).not.toContain('## Links\n')
    expect(daily).toContain('[[capture-2026-06-11-090000-000-0000|Old]]')
    expect(daily).toContain(
      '## [[Links]]\n\n- [[capture-2026-06-11-153022-845-7c9e|An article]]\n\n[[capture-2026-06-11-090000-000-0000|Old]]',
    )
  })

  it('extends only the leading Links list, before later daily-note prose', async () => {
    files.set(DAILY, '## [[Links]]\n\n- [[Old]]\n- [[Older]]\n\nScratchpad for later.\n')
    addSpool(envelope())

    await drain()

    expect(files.get(DAILY)).toBe(
      '## [[Links]]\n\n- [[Old]]\n- [[Older]]\n- [[capture-2026-06-11-153022-845-7c9e|An article]]\n\nScratchpad for later.\n',
    )
  })

  it('reuses an existing linked Links section for same-day dedup', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()

    addSpool(envelope())
    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    const daily = files.get(DAILY) ?? ''
    expect(daily.match(/## \[\[Links\]\]/g)).toHaveLength(1)
    expect(daily.match(/capture-2026-06-11-093000-000-0000/g)).toHaveLength(1)
  })

  it('does not treat a nested Links heading as the daily capture section', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    files.set(
      DAILY,
      '> ## [[Links]]\n>\n> - [[capture-2026-06-11-093000-000-0000|An article]]\n',
    )

    addSpool(envelope())
    const outcome = await drain()

    expect(outcome.deduped).toBe(0)
    expect(files.has(IDENTITY.notePath)).toBe(true)
    expect(files.get(DAILY)).toContain(
      '\n## [[Links]]\n\n- [[capture-2026-06-11-153022-845-7c9e|An article]]\n',
    )
  })

  it('upgrades a legacy heading even when a same-day recapture is deduplicated', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    files.set(DAILY, (files.get(DAILY) ?? '').replace('## [[Links]]', '## Links'))

    addSpool(envelope())
    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    expect(files.get(DAILY)).toContain('## [[Links]]')
    expect(files.get(DAILY)).not.toContain('## Links\n')
  })

  it('deduplicates across every matching Links section', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    files.set(DAILY, `## Links\n\n- [[Old]]\n\n${files.get(DAILY) ?? ''}`)

    addSpool(envelope())
    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    expect(files.has(IDENTITY.notePath)).toBe(false)
  })

  it('keeps the spool retryable when the Links note cannot be ensured', async () => {
    addSpool(envelope())
    ensureBacklinkTargetMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await drain()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'disk full' })
    expect(files.size).toBe(0)
    expect(spool.size).toBe(2)
  })

  it('uses the current title when the Links note was renamed', async () => {
    ensureBacklinkTargetMock.mockResolvedValue('Bookmarks')
    addSpool(envelope())

    await drain()

    expect(files.get(DAILY)).toContain('## [[Bookmarks]]')
    expect(files.get(DAILY)).not.toContain('## [[Links]]')
    expect(ensureBacklinkTargetMock).toHaveBeenCalledWith('Links', 3)
  })

  it('deduplicates captures under a renamed Links heading', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    files.set(DAILY, (files.get(DAILY) ?? '').replace('[[Links]]', '[[Bookmarks]]'))
    ensureBacklinkTargetMock.mockResolvedValue('Bookmarks')

    addSpool(envelope())
    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    expect(files.has(IDENTITY.notePath)).toBe(false)
    expect(files.get(DAILY)).toContain('## [[Bookmarks]]')
  })

  it('saves a private-day capture raw, marked skipped', async () => {
    files.set(DAILY, '---\nprivate: true\n---\n\nsecret plans\n')
    addSpool(envelope())

    const outcome = await drain()

    expect(outcome.drained).toBe(1)
    expect(files.get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(files.get(DAILY)).toContain('- [[capture-2026-06-11-153022-845-7c9e|An article]]')
  })

  it('refreshes a same-day same-URL same-selection re-capture in place', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    const originalNotePath = 'notes/capture-2026-06-11-093000-000-0000.md'
    expect(files.has(originalNotePath)).toBe(true)

    addSpool(envelope()) // same URL, no selection, same day, 15:30
    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    // The existing identity is reused — no orphan note under the new stamp.
    expect(files.has(IDENTITY.notePath)).toBe(false)
    expect(files.get(originalNotePath)).toContain('captureStatus: pending')
    expect(promoteMock).toHaveBeenLastCalledWith(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg',
      'assets/capture-2026-06-11-093000-000-0000.jpg',
      1600,
      3,
    )
    const daily = files.get(DAILY) ?? ''
    expect(daily.match(/capture-2026-06-11-093000-000-0000/g)).toHaveLength(1)
    expect(daily).not.toContain('capture-2026-06-11-153022-845')
  })

  it('a dedup refresh re-syncs the daily link text with the fresh tab title', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    // Simulate a completed enrichment: H1 and daily link text carry the AI title.
    const notePath = 'notes/capture-2026-06-11-093000-000-0000.md'
    files.set(notePath, (files.get(notePath) ?? '').replace('# An article', '# AI Title'))
    files.set(DAILY, (files.get(DAILY) ?? '').replace('|An article]]', '|AI Title]]'))

    addSpool(envelope()) // same URL re-capture, 15:30
    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    expect(files.get(notePath)).toContain('# An article')
    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain('|An article]]')
    expect(daily).not.toContain('|AI Title]]')
  })

  it('a dedup refresh leaves a user-edited daily link text alone', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()
    files.set(DAILY, (files.get(DAILY) ?? '').replace('|An article]]', '|my own link text]]'))

    addSpool(envelope({ title: 'An article - Example News' }))
    const outcome = await drain()

    expect(outcome.deduped).toBe(1)
    expect(files.get('notes/capture-2026-06-11-093000-000-0000.md')).toContain(
      '# An article - Example News',
    )
    expect(files.get(DAILY)).toContain('|my own link text]]')
  })

  it('a different selection creates a new entry instead of refreshing', async () => {
    addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await drain()

    addSpool(envelope({ selection: 'a fresh highlight' }))
    const outcome = await drain()

    expect(outcome.deduped).toBe(0)
    expect(files.has(IDENTITY.notePath)).toBe(true)
    const daily = files.get(DAILY) ?? ''
    expect(daily).toContain('capture-2026-06-11-093000-000')
    expect(daily).toContain('capture-2026-06-11-153022-845')
  })

  it('re-drains idempotently after a crash between note write and spool removal', async () => {
    addSpool(envelope())
    await drain()
    // Simulate the crashed pass: the spool files are back (never removed).
    addSpool(envelope())

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    const daily = files.get(DAILY) ?? ''
    expect(daily.match(/capture-2026-06-11-153022-845/g)).toHaveLength(1)
  })

  it('quarantines an unparseable spool file instead of wedging the queue or deleting it', async () => {
    spool.set('garbage.json', { contents: 'not json', modifiedMs: 0 })
    addSpool(envelope({ id: '00000000-0000-4000-8000-000000000001' }))

    const outcome = await drain()

    expect(outcome.invalid).toBe(1)
    expect(outcome.drained).toBe(1)
    expect(spool.has('garbage.json')).toBe(false)
    // Moved, never deleted — a newer extension's envelope must survive an
    // older app that can't parse it yet.
    expect(rejected.get('garbage.json')).toBe('not json')
    expect(inboxRemoveMock).not.toHaveBeenCalledWith('garbage.json', 3)
    expect(writeNoteMock).toHaveBeenCalled()
  })

  it('drains two same-millisecond captures of different pages into distinct notes', async () => {
    addSpool(
      envelope({ id: '00000000-0000-4000-8000-000000000001', url: 'https://a.com' }),
      { screenshot: false },
    )
    addSpool(
      envelope({ id: 'ffff0000-0000-4000-8000-000000000002', url: 'https://b.com' }),
      { screenshot: false },
    )

    const outcome = await drain()

    expect(outcome.drained).toBe(2)
    expect(files.has('notes/capture-2026-06-11-153022-845-0000.md')).toBe(true)
    expect(files.has('notes/capture-2026-06-11-153022-845-ffff.md')).toBe(true)
  })

  it('saves a capture whose screenshot cannot decode, without wedging the pass', async () => {
    addSpool(envelope())
    promoteMock.mockRejectedValue({ kind: 'parse', message: 'screenshot does not decode' })

    const outcome = await drain()

    // Retrying identical bytes can't help — the capture lands without its
    // image instead of permanently blocking every capture behind it.
    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('![')
    expect(note).not.toContain('captureScreenshot')
    expect(spool.size).toBe(0)
  })

  it('saves a capture whose screenshot sibling never landed, without the image', async () => {
    addSpool(envelope())
    spool.delete('7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg')

    const outcome = await drain()

    expect(outcome.drained).toBe(1)
    const note = files.get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('![')
    expect(note).not.toContain('captureScreenshot')
  })

  it('sweeps old orphan screenshots but never young ones', async () => {
    spool.set('11111111-1111-4111-8111-111111111111.jpg', { contents: 'x', modifiedMs: 0 })
    spool.set('22222222-2222-4222-8222-222222222222.jpg', {
      contents: 'x',
      modifiedMs: 9_000_000,
    })

    await drain({ now: () => 10_000_000 }) // first is ~2.8h old, second ~17min

    expect(spool.has('11111111-1111-4111-8111-111111111111.jpg')).toBe(false)
    expect(spool.has('22222222-2222-4222-8222-222222222222.jpg')).toBe(true)
  })

  it('stops before any work when the session is stale', async () => {
    addSpool(envelope())
    const outcome = await drain({ isStale: () => true })
    expect(outcome.stopped?.reason).toBe('stale')
    expect(writeNoteMock).not.toHaveBeenCalled()
    expect(spool.size).toBe(2)
  })

  it('a write failure stops the pass with the error kind', async () => {
    addSpool(envelope())
    writeNoteMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await drain()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'disk full' })
    expect(spool.size).toBe(2) // nothing removed — the capture is retryable
  })
})

describe('drainCaptureInbox (text captures)', () => {
  function textEnvelope(overrides: Partial<TextCaptureEnvelope> = {}): TextCaptureEnvelope {
    return {
      version: 1,
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      kind: 'append',
      text: 'call the bank',
      capturedAt: CAPTURED_AT.toISOString(),
      source: 'deep-link',
      ...overrides,
    }
  }

  function addTextSpool(capture: TextCaptureEnvelope): void {
    spool.set(`${capture.id}.json`, { contents: JSON.stringify(capture), modifiedMs: 0 })
  }

  it('appends a bullet to the capture-day daily and removes the spool', async () => {
    addTextSpool(textEnvelope())

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    expect(files.get(DAILY)).toBe('- call the bank\n')
    expect(spool.size).toBe(0)
  })

  it('appends a task envelope as an open GFM checkbox', async () => {
    addTextSpool(textEnvelope({ kind: 'task', text: 'buy milk' }))

    await drain()

    expect(files.get(DAILY)).toBe('- [ ] buy milk\n')
  })

  it('appends after existing daily content as its own block', async () => {
    files.set(DAILY, '- morning standup\n')
    addTextSpool(textEnvelope())

    await drain()

    expect(files.get(DAILY)).toBe('- morning standup\n\n- call the bank\n')
  })

  it('still appends when an existing line merely contains the capture as a substring', async () => {
    files.set(DAILY, '- call the bank tomorrow morning\n')
    addTextSpool(textEnvelope())

    const outcome = await drain()

    expect(outcome.deduped).toBe(0)
    expect(files.get(DAILY)).toBe('- call the bank tomorrow morning\n\n- call the bank\n')
  })

  it('dedupes against a CRLF daily — a carriage return must not defeat the line match', async () => {
    files.set(DAILY, '- morning standup\r\n- call the bank\r\n')
    addTextSpool(textEnvelope())

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    expect(files.get(DAILY)).toBe('- morning standup\r\n- call the bank\r\n')
  })

  it('re-draining after a crash between append and removal cannot double-append', async () => {
    files.set(DAILY, '- call the bank\n')
    addTextSpool(textEnvelope())

    const outcome = await drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    expect(files.get(DAILY)).toBe('- call the bank\n')
    expect(spool.size).toBe(0)
  })

  it('still appends to a private daily — the write is entirely local', async () => {
    files.set(DAILY, '---\nprivate: true\n---\n\n- secret plans\n')
    addTextSpool(textEnvelope())

    await drain()

    expect(files.get(DAILY)).toContain('- call the bank')
    expect(scrapeMock).not.toHaveBeenCalled()
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('quarantines a text envelope that fails validation', async () => {
    addTextSpool(textEnvelope({ text: 'line one\nline two' }))

    const outcome = await drain()

    expect(outcome.invalid).toBe(1)
    expect(rejected.has('a1b2c3d4-0000-4000-8000-000000000001.json')).toBe(true)
    expect(files.has(DAILY)).toBe(false)
  })

  it('never writes a capture note for a text envelope', async () => {
    addTextSpool(textEnvelope())

    await drain()

    expect([...files.keys()]).toEqual([DAILY])
  })
})
