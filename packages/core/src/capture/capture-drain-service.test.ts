import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import fixtures from './bookmark-envelope.fixtures.json' with { type: 'json' }
import type { TextCaptureEnvelope } from './capture-envelope.ts'
import {
  CAPTURED_AT,
  createCaptureTestKit,
  DAILY,
  envelope,
  IDENTITY,
  type CaptureTestKit,
} from './capture-test-kit.ts'

let kit: CaptureTestKit

beforeEach(() => {
  kit = createCaptureTestKit()
})

describe('CaptureDrainService', () => {
  it('writes the capture note, daily entry, and asset — then removes the spool', async () => {
    kit.addSpool(envelope({ selection: 'quoted text', note: 'check later' }))

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    expect(kit.promoteMock).toHaveBeenCalledWith(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg',
      IDENTITY.assetPath,
      1600,
      3,
    )
    const note = kit.noteFile.files().get(IDENTITY.notePath)
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

    const daily = kit.noteFile.files().get(DAILY)
    expect(daily).toContain('## [[Links]]')
    expect(daily).toContain('- [[capture-2026-06-11-153022-845-7c9e|An article]]')
    expect(kit.ensureBacklinkTargetMock).toHaveBeenCalledWith('Links', 3)
    expect(kit.captureInbox.files().size).toBe(0)
  })

  it('writes extracted page text into the capture note', async () => {
    kit.addSpool(envelope({ contentText: 'First paragraph.\n\nSecond paragraph.' }), {
      screenshot: false,
    })

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath)
    expect(note).toContain(
      '## Page Text\n\n<!-- reflect-capture-page-text:start -->\nFirst paragraph.\n\nSecond paragraph.\n<!-- reflect-capture-page-text:end -->',
    )
  })

  it('writes an iOS share capture with its in-page description into the raw save', async () => {
    kit.addSpool(
      envelope({ source: 'ios-share', metaDescription: '  A page\nabout examples.  ' }),
      {
        screenshot: false,
      },
    )

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath)
    expect(note).toContain('captureSource: ios-share')
    // Whitespace-folded onto the one metadata line, right where enrichment
    // will replace it in place.
    expect(note).toContain('- Type: #link\n- Description: A page about examples.')
    expect(note).toContain('captureStatus: pending')
  })

  it('removes the spool only after the note and daily entry are written', async () => {
    kit.addSpool(envelope())
    await kit.drain()
    const lastWrite = Math.max(...kit.writeNoteMock.mock.invocationCallOrder)
    const firstRemove = Math.min(...kit.inboxRemoveMock.mock.invocationCallOrder)
    expect(firstRemove).toBeGreaterThan(lastWrite)
  })

  it('drains a batch that arrived while the app was closed, oldest first', async () => {
    kit.addSpool(envelope({ id: '00000000-0000-4000-8000-000000000002', url: 'https://b.com' }), {
      modifiedMs: 200,
    })
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        url: 'https://a.com',
        capturedAt: new Date(2026, 5, 11, 9, 0, 0, 0).toISOString(),
      }),
      { modifiedMs: 100 },
    )

    const outcome = await kit.drain()

    expect(outcome.drained).toBe(2)
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily.indexOf('capture-2026-06-11-090000-000')).toBeLessThan(
      daily.indexOf('capture-2026-06-11-153022-845'),
    )
    expect(kit.captureInbox.files().size).toBe(0)
  })

  it('upgrades the existing plain Links section without duplicating it', async () => {
    kit.noteFile.set(DAILY, '# plans\n\n## Links\n\n[[capture-2026-06-11-090000-000-0000|Old]]\n')
    kit.addSpool(envelope())

    await kit.drain()

    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily.match(/## \[\[Links\]\]/g)).toHaveLength(1)
    expect(daily).not.toContain('## Links\n')
    expect(daily).toContain('[[capture-2026-06-11-090000-000-0000|Old]]')
    expect(daily).toContain(
      '## [[Links]]\n\n- [[capture-2026-06-11-153022-845-7c9e|An article]]\n\n[[capture-2026-06-11-090000-000-0000|Old]]',
    )
  })

  it('extends only the leading Links list, before later daily-note prose', async () => {
    kit.noteFile.set(DAILY, '## [[Links]]\n\n- [[Old]]\n- [[Older]]\n\nScratchpad for later.\n')
    kit.addSpool(envelope())

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toBe(
      '## [[Links]]\n\n- [[Old]]\n- [[Older]]\n- [[capture-2026-06-11-153022-845-7c9e|An article]]\n\nScratchpad for later.\n',
    )
  })

  it('reuses an existing linked Links section for same-day dedup', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()

    kit.addSpool(envelope())
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(1)
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily.match(/## \[\[Links\]\]/g)).toHaveLength(1)
    expect(daily.match(/capture-2026-06-11-093000-000-0000/g)).toHaveLength(1)
  })

  it('does not treat a nested Links heading as the daily capture section', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    kit.noteFile.set(
      DAILY,
      '> ## [[Links]]\n>\n> - [[capture-2026-06-11-093000-000-0000|An article]]\n',
    )

    kit.addSpool(envelope())
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(0)
    expect(kit.noteFile.files().has(IDENTITY.notePath)).toBe(true)
    expect(kit.noteFile.files().get(DAILY)).toContain(
      '\n## [[Links]]\n\n- [[capture-2026-06-11-153022-845-7c9e|An article]]\n',
    )
  })

  it('upgrades a legacy heading even when a same-day recapture is deduplicated', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    kit.noteFile.set(
      DAILY,
      (kit.noteFile.files().get(DAILY) ?? '').replace('## [[Links]]', '## Links'),
    )

    kit.addSpool(envelope())
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(1)
    expect(kit.noteFile.files().get(DAILY)).toContain('## [[Links]]')
    expect(kit.noteFile.files().get(DAILY)).not.toContain('## Links\n')
  })

  it('deduplicates under an H1 or formatted Links heading, as insertion files there', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    kit.noteFile.set(
      DAILY,
      (kit.noteFile.files().get(DAILY) ?? '').replace('## [[Links]]', '# **Links**'),
    )

    kit.addSpool(envelope())
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(1)
    expect(kit.noteFile.files().has(IDENTITY.notePath)).toBe(false)
  })

  it('deduplicates across every matching Links section', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    kit.noteFile.set(DAILY, `## Links\n\n- [[Old]]\n\n${kit.noteFile.files().get(DAILY) ?? ''}`)

    kit.addSpool(envelope())
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(1)
    expect(kit.noteFile.files().has(IDENTITY.notePath)).toBe(false)
  })

  it('keeps the spool retryable when the Links note cannot be ensured', async () => {
    kit.addSpool(envelope())
    kit.ensureBacklinkTargetMock.mockRejectedValue(new AppError('io', 'disk full'))

    const outcome = await kit.drain()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'disk full' })
    expect(kit.noteFile.files().size).toBe(0)
    expect(kit.captureInbox.files().size).toBe(2)
  })

  it('uses the current title when the Links note was renamed', async () => {
    kit.ensureBacklinkTargetMock.mockResolvedValue('Bookmarks')
    kit.addSpool(envelope())

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toContain('## [[Bookmarks]]')
    expect(kit.noteFile.files().get(DAILY)).not.toContain('## [[Links]]')
    expect(kit.ensureBacklinkTargetMock).toHaveBeenCalledWith('Links', 3)
  })

  it('deduplicates captures under a renamed Links heading', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    kit.noteFile.set(
      DAILY,
      (kit.noteFile.files().get(DAILY) ?? '').replace('[[Links]]', '[[Bookmarks]]'),
    )
    kit.ensureBacklinkTargetMock.mockResolvedValue('Bookmarks')

    kit.addSpool(envelope())
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(1)
    expect(kit.noteFile.files().has(IDENTITY.notePath)).toBe(false)
    expect(kit.noteFile.files().get(DAILY)).toContain('## [[Bookmarks]]')
  })

  it('saves a private-day capture raw, marked skipped', async () => {
    kit.noteFile.set(DAILY, '---\nprivate: true\n---\n\nsecret plans\n')
    kit.addSpool(envelope())

    const outcome = await kit.drain()

    expect(outcome.drained).toBe(1)
    expect(kit.noteFile.files().get(IDENTITY.notePath)).toContain('captureStatus: skipped')
    expect(kit.noteFile.files().get(DAILY)).toContain(
      '- [[capture-2026-06-11-153022-845-7c9e|An article]]',
    )
  })

  it('refreshes a same-day same-URL same-selection re-capture in place', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    const originalNotePath = 'notes/capture-2026-06-11-093000-000-0000.md'
    expect(kit.noteFile.files().has(originalNotePath)).toBe(true)

    kit.addSpool(envelope()) // same URL, no selection, same day, 15:30
    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    // The existing identity is reused — no orphan note under the new stamp.
    expect(kit.noteFile.files().has(IDENTITY.notePath)).toBe(false)
    expect(kit.noteFile.files().get(originalNotePath)).toContain('captureStatus: pending')
    expect(kit.promoteMock).toHaveBeenLastCalledWith(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg',
      'assets/capture-2026-06-11-093000-000-0000.jpg',
      1600,
      3,
    )
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily.match(/capture-2026-06-11-093000-000-0000/g)).toHaveLength(1)
    expect(daily).not.toContain('capture-2026-06-11-153022-845')
  })

  it('a dedup refresh re-syncs the daily link text with the fresh tab title', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    // Simulate a completed enrichment: H1 and daily link text carry the AI title.
    const notePath = 'notes/capture-2026-06-11-093000-000-0000.md'
    kit.noteFile.set(
      notePath,
      (kit.noteFile.files().get(notePath) ?? '').replace('# An article', '# AI Title'),
    )
    kit.noteFile.set(
      DAILY,
      (kit.noteFile.files().get(DAILY) ?? '').replace('|An article]]', '|AI Title]]'),
    )

    kit.addSpool(envelope()) // same URL re-capture, 15:30
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(1)
    expect(kit.noteFile.files().get(notePath)).toContain('# An article')
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily).toContain('|An article]]')
    expect(daily).not.toContain('|AI Title]]')
  })

  it('a dedup refresh leaves a user-edited daily link text alone', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()
    kit.noteFile.set(
      DAILY,
      (kit.noteFile.files().get(DAILY) ?? '').replace('|An article]]', '|my own link text]]'),
    )

    kit.addSpool(envelope({ title: 'An article - Example News' }))
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(1)
    expect(kit.noteFile.files().get('notes/capture-2026-06-11-093000-000-0000.md')).toContain(
      '# An article - Example News',
    )
    expect(kit.noteFile.files().get(DAILY)).toContain('|my own link text]]')
  })

  it('a different selection creates a new entry instead of refreshing', async () => {
    kit.addSpool(
      envelope({
        id: '00000000-0000-4000-8000-000000000001',
        capturedAt: new Date(2026, 5, 11, 9, 30, 0, 0).toISOString(),
      }),
    )
    await kit.drain()

    kit.addSpool(envelope({ selection: 'a fresh highlight' }))
    const outcome = await kit.drain()

    expect(outcome.deduped).toBe(0)
    expect(kit.noteFile.files().has(IDENTITY.notePath)).toBe(true)
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily).toContain('capture-2026-06-11-093000-000')
    expect(daily).toContain('capture-2026-06-11-153022-845')
  })

  it('re-drains idempotently after a crash between note write and spool removal', async () => {
    kit.addSpool(envelope())
    await kit.drain()
    // Simulate the crashed pass: the spool files are back (never removed).
    kit.addSpool(envelope())

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 1, invalid: 0, stopped: null })
    const daily = kit.noteFile.files().get(DAILY) ?? ''
    expect(daily.match(/capture-2026-06-11-153022-845/g)).toHaveLength(1)
  })

  it('quarantines an unparseable spool file instead of wedging the queue or deleting it', async () => {
    kit.captureInbox.add('garbage.json', 'not json', { modifiedMs: 0 })
    kit.addSpool(envelope({ id: '00000000-0000-4000-8000-000000000001' }))

    const outcome = await kit.drain()

    expect(outcome.invalid).toBe(1)
    expect(outcome.drained).toBe(1)
    expect(kit.captureInbox.files().has('garbage.json')).toBe(false)
    // Moved, never deleted — a newer extension's envelope must survive an
    // older app that can't parse it yet.
    expect(kit.captureInbox.rejected()).toContain('garbage.json')
    expect(kit.inboxRemoveMock).not.toHaveBeenCalledWith('garbage.json', 3)
    expect(kit.writeNoteMock).toHaveBeenCalled()
  })

  it('drains two same-millisecond captures of different pages into distinct notes', async () => {
    kit.addSpool(envelope({ id: '00000000-0000-4000-8000-000000000001', url: 'https://a.com' }), {
      screenshot: false,
    })
    kit.addSpool(envelope({ id: 'ffff0000-0000-4000-8000-000000000002', url: 'https://b.com' }), {
      screenshot: false,
    })

    const outcome = await kit.drain()

    expect(outcome.drained).toBe(2)
    expect(kit.noteFile.files().has('notes/capture-2026-06-11-153022-845-0000.md')).toBe(true)
    expect(kit.noteFile.files().has('notes/capture-2026-06-11-153022-845-ffff.md')).toBe(true)
  })

  it('saves a capture whose screenshot cannot decode, without wedging the pass', async () => {
    kit.addSpool(envelope())
    kit.promoteMock.mockRejectedValue(new AppError('parse', 'screenshot does not decode'))

    const outcome = await kit.drain()

    // Retrying identical bytes can't help — the capture lands without its
    // image instead of permanently blocking every capture behind it.
    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('![')
    expect(note).not.toContain('captureScreenshot')
    expect(kit.captureInbox.files().size).toBe(0)
  })

  it('saves a capture whose screenshot sibling never landed, without the image', async () => {
    kit.addSpool(envelope())
    await kit.captureInbox.remove('7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg', 3)

    const outcome = await kit.drain()

    expect(outcome.drained).toBe(1)
    const note = kit.noteFile.files().get(IDENTITY.notePath) ?? ''
    expect(note).not.toContain('![')
    expect(note).not.toContain('captureScreenshot')
  })

  it('sweeps old orphan screenshots but never young ones', async () => {
    kit.captureInbox.add('11111111-1111-4111-8111-111111111111.jpg', 'x', { modifiedMs: 0 })
    kit.captureInbox.add('22222222-2222-4222-8222-222222222222.jpg', 'x', { modifiedMs: 9_000_000 })

    kit.clock.setNow(10_000_000) // first is ~2.8h old, second ~17min
    await kit.drain()

    expect(kit.captureInbox.files().has('11111111-1111-4111-8111-111111111111.jpg')).toBe(false)
    expect(kit.captureInbox.files().has('22222222-2222-4222-8222-222222222222.jpg')).toBe(true)
  })

  it('stops before any work when the session is stale', async () => {
    kit.addSpool(envelope())
    const outcome = await kit.drain({ isStale: () => true })
    expect(outcome.stopped?.reason).toBe('stale')
    expect(kit.writeNoteMock).not.toHaveBeenCalled()
    expect(kit.captureInbox.files().size).toBe(2)
  })

  it('a write failure stops the pass with the error kind', async () => {
    kit.addSpool(envelope())
    kit.writeNoteMock.mockRejectedValue(new AppError('io', 'disk full'))

    const outcome = await kit.drain()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'disk full' })
    expect(kit.captureInbox.files().size).toBe(2) // nothing removed — the capture is retryable
  })
})

describe('CaptureDrainService (text captures)', () => {
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
    kit.captureInbox.add(`${capture.id}.json`, JSON.stringify(capture), { modifiedMs: 0 })
  }

  it('appends a bullet to the capture-day daily and removes the spool', async () => {
    addTextSpool(textEnvelope())

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    expect(kit.noteFile.files().get(DAILY)).toBe('- call the bank\n')
    expect(kit.captureInbox.files().size).toBe(0)
  })

  it('puts a task envelope in a new Tasks section as a round (+) task', async () => {
    addTextSpool(textEnvelope({ kind: 'task', text: 'buy milk' }))

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toBe('## Tasks\n\n+ [ ] buy milk\n')
  })

  it('places a task capture in the existing Tasks section without creating a note', async () => {
    kit.noteFile.set(DAILY, '## Tasks\n\n+ [ ] old\n\n## Later\n\nprose\n')
    addTextSpool(textEnvelope({ kind: 'task', text: 'buy milk' }))

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toBe(
      '## Tasks\n\n+ [ ] old\n+ [ ] buy milk\n\n## Later\n\nprose\n',
    )
    expect([...kit.noteFile.files().keys()].filter((path) => path !== DAILY)).toEqual([])
  })

  it('appends a checkbox envelope as a square GFM checkbox', async () => {
    addTextSpool(textEnvelope({ kind: 'checkbox', text: 'pack a bag' }))

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toBe('- [ ] pack a bag\n')
  })

  it('joins the daily note’s trailing bullet list instead of opening a new block', async () => {
    kit.noteFile.set(DAILY, '- morning standup\n')
    addTextSpool(textEnvelope())

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toBe('- morning standup\n- call the bank\n')
  })

  it('two same-day captures grow one list', async () => {
    addTextSpool(textEnvelope())
    kit.captureInbox.add(
      'a1b2c3d4-0000-4000-8000-000000000002.json',
      JSON.stringify(
        textEnvelope({ id: 'a1b2c3d4-0000-4000-8000-000000000002', text: 'buy milk' }),
      ),
      { modifiedMs: 1 },
    )

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 2, drained: 2, deduped: 0, invalid: 0, stopped: null })
    expect(kit.noteFile.files().get(DAILY)).toBe('- call the bank\n- buy milk\n')
  })

  it('starts a fresh list after a prose tail', async () => {
    kit.noteFile.set(DAILY, 'Wrote some prose.\n')
    addTextSpool(textEnvelope())

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toBe('Wrote some prose.\n\n- call the bank\n')
  })

  it('appends a duplicate line — identical text twice is two entries', async () => {
    kit.noteFile.set(DAILY, '- call the bank\n')
    addTextSpool(textEnvelope())

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    expect(kit.noteFile.files().get(DAILY)).toBe('- call the bank\n- call the bank\n')
    expect(kit.captureInbox.files().size).toBe(0)
  })

  it('drains an ios-intent envelope like any other text source', async () => {
    addTextSpool(textEnvelope({ source: 'ios-intent' }))

    const outcome = await kit.drain()

    expect(outcome).toEqual({ pending: 1, drained: 1, deduped: 0, invalid: 0, stopped: null })
    expect(kit.noteFile.files().get(DAILY)).toBe('- call the bank\n')
  })

  it('a checkbox never joins a task list — the + marker stays a task', async () => {
    kit.noteFile.set(DAILY, '+ [ ] buy milk\n')
    addTextSpool(textEnvelope({ kind: 'checkbox', text: 'pack a bag' }))

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toBe('+ [ ] buy milk\n- [ ] pack a bag\n')
  })

  it('still appends to a private daily — the write is entirely local', async () => {
    kit.noteFile.set(DAILY, '---\nprivate: true\n---\n\n- secret plans\n')
    addTextSpool(textEnvelope())

    await kit.drain()

    expect(kit.noteFile.files().get(DAILY)).toContain('- call the bank')
    expect(kit.scrapeMock).not.toHaveBeenCalled()
    expect(kit.describeMock).not.toHaveBeenCalled()
  })

  it('quarantines a text envelope that fails validation', async () => {
    addTextSpool(textEnvelope({ text: 'line one\nline two' }))

    const outcome = await kit.drain()

    expect(outcome.invalid).toBe(1)
    expect(kit.captureInbox.rejected()).toContain('a1b2c3d4-0000-4000-8000-000000000001.json')
    expect(kit.noteFile.files().has(DAILY)).toBe(false)
  })

  it('never writes a capture note for a text envelope', async () => {
    addTextSpool(textEnvelope())

    await kit.drain()

    expect([...kit.noteFile.files().keys()]).toEqual([DAILY])
  })
})

it('isolates a failed bookmark write from later page captures', async () => {
  const bookmark = { ...fixtures.spooled[0]!, id: '00000000-0000-4000-8000-000000000001' }
  const name = `${bookmark.id}.json`
  kit.captureInbox.add(name, JSON.stringify(bookmark), { modifiedMs: -1 })
  kit.addSpool(envelope())
  const writeXPost = vi.fn(async () => {
    throw new Error('Daily note busy')
  })
  const outcome = await kit.drain({ writeXPost })
  expect(outcome.drained).toBe(1)
  expect(outcome.invalid).toBe(0)
  expect(kit.captureInbox.files().has(name)).toBe(true)
  expect(writeXPost).toHaveBeenCalledTimes(1)
  expect(outcome.stopped?.message).toBe('Daily note busy')
})
