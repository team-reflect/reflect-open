import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureIdentity, captureLocalDate, type CaptureIdentity } from './capture-identity.ts'
import {
  createCaptureLinkRepairService,
  repairCaptureLinks,
  type CaptureLinkRepairService,
} from './capture-link-repair-service.ts'
import { captureNoteSource } from './capture-note.ts'
import {
  createOpenDocumentsService,
  type OpenDocumentsService,
} from '../documents/open-documents-service.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import {
  createTestClockService,
  createTestFileChangeService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestNoteSession,
  type TestNoteFileService,
} from '../testing/index.ts'

const CAPTURED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const IDENTITY = captureIdentity(CAPTURED_AT, '7c9e6679-7425-40de-944b-e07fc1f90ae7')
const OTHER = captureIdentity(CAPTURED_AT, '1b2c3d4e-7425-40de-944b-e07fc1f90ae7')
const DAILY = 'daily/2026-06-11.md'
const PLACEHOLDER_LINK = `[[${IDENTITY.base}|www.instagram.com]]`
const TITLED_LINK = `[[${IDENTITY.base}|Kitchen design decisions part 2]]`

/**
 * A capture note the drain wrote for an untitled share, then retitled to `title`.
 */
async function captureNote(
  options: {
    title?: string
    status?: 'pending' | 'done' | 'skipped'
    extra?: Record<string, unknown>
    capturedAt?: Date
  } = {},
): Promise<{ identity: CaptureIdentity; source: string }> {
  const capturedAt = options.capturedAt ?? CAPTURED_AT
  const identity = captureIdentity(capturedAt, '7c9e6679-7425-40de-944b-e07fc1f90ae7')
  const source = await captureNoteSource(
    {
      version: 1,
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      url: 'https://www.instagram.com/reel/DdEw84HR2CV/',
      title: '',
      capturedAt: capturedAt.toISOString(),
      source: 'ios-share',
    },
    identity,
    { hasScreenshot: false, status: options.status ?? 'done' },
  )
  const retitled = source.replace(
    '# www.instagram.com',
    `# ${options.title ?? 'Kitchen design decisions part 2'}`,
  )
  return {
    identity,
    source: options.extra === undefined ? retitled : upsertFrontmatter(retitled, options.extra),
  }
}

describe('repairCaptureLinks', () => {
  const repairs = new Map([
    [IDENTITY.base, { placeholder: 'www.instagram.com', title: 'Costs $& more' }],
  ])

  it('rewrites every placeholder link of the capture and keeps `$` literal', () => {
    const daily = `- ${PLACEHOLDER_LINK}\n- again ${PLACEHOLDER_LINK}\n`
    expect(repairCaptureLinks(daily, repairs)).toBe(
      `- [[${IDENTITY.base}|Costs $& more]]\n- again [[${IDENTITY.base}|Costs $& more]]\n`,
    )
  })

  it('leaves other link text, other captures, and code alone', () => {
    const daily = [
      `- [[${IDENTITY.base}|my own words]]`,
      `- [[${OTHER.base}|www.instagram.com]]`,
      '',
      '```',
      PLACEHOLDER_LINK,
      '```',
      '',
    ].join('\n')
    expect(repairCaptureLinks(daily, repairs)).toBe(daily)
  })

  it('is idempotent', () => {
    const once = repairCaptureLinks(`- ${PLACEHOLDER_LINK}\n`, repairs)
    expect(repairCaptureLinks(once, repairs)).toBe(once)
  })
})

describe('CaptureLinkRepairService', () => {
  let noteFile: TestNoteFileService
  let openDocuments: OpenDocumentsService
  let repair: CaptureLinkRepairService

  beforeEach(() => {
    noteFile = createTestNoteFileService()
    openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
    repair = createCaptureLinkRepairService({
      noteFile,
      openDocuments,
      clock: createTestClockService({ now: CAPTURED_AT.getTime() + 60_000 }),
      logger: createTestLoggerService(),
    })
  })

  async function addCapture(options: Parameters<typeof captureNote>[0] = {}): Promise<void> {
    const { identity, source } = await captureNote(options)
    noteFile.set(identity.notePath, source)
  }

  it('rewrites a placeholder link to the finished capture title', async () => {
    await addCapture()
    noteFile.set(DAILY, `## [[Links]]\n\n- ${PLACEHOLDER_LINK}\n`)

    await repair.sweep(3)

    expect(noteFile.files().get(DAILY)).toBe(`## [[Links]]\n\n- ${TITLED_LINK}\n`)
  })

  it.each([
    ['a pending capture', { status: 'pending' as const }],
    ['a skipped capture', { status: 'skipped' as const }],
    ['a capture with a retitle in progress', { extra: { captureDailyFromTitle: 'x' } }],
    ['a private capture', { extra: { private: true } }],
    ['a capture still titled with its placeholder', { title: 'www.instagram.com' }],
  ])('leaves the link of %s alone', async (_name, options) => {
    await addCapture(options)
    const daily = `- ${PLACEHOLDER_LINK}\n`
    noteFile.set(DAILY, daily)

    await repair.sweep(3)

    expect(noteFile.files().get(DAILY)).toBe(daily)
  })

  it('leaves captures older than the repair window alone', async () => {
    const capturedAt = new Date(CAPTURED_AT.getTime() - 31 * 24 * 60 * 60 * 1000)
    const { identity, source } = await captureNote({ capturedAt })
    noteFile.set(identity.notePath, source)
    const oldDaily = `daily/${captureLocalDate(capturedAt)}.md`
    const daily = `- [[${identity.base}|www.instagram.com]]\n`
    noteFile.set(oldDaily, daily)
    const read = vi.spyOn(noteFile, 'read')

    await repair.sweep(3)

    expect(noteFile.files().get(oldDaily)).toBe(daily)
    expect(read).not.toHaveBeenCalled()
  })

  it('repairs a private daily, which only changes local text', async () => {
    await addCapture()
    noteFile.set(DAILY, `---\nprivate: true\n---\n\n- ${PLACEHOLDER_LINK}\n`)

    await repair.sweep(3)

    expect(noteFile.files().get(DAILY)).toBe(`---\nprivate: true\n---\n\n- ${TITLED_LINK}\n`)
  })

  it('leaves user-written link text alone', async () => {
    await addCapture()
    const daily = `- [[${IDENTITY.base}|my own words]]\n`
    noteFile.set(DAILY, daily)

    await repair.sweep(3)

    expect(noteFile.files().get(DAILY)).toBe(daily)
  })

  it('edits an open daily through its session', async () => {
    await addCapture()
    noteFile.set(DAILY, `- ${PLACEHOLDER_LINK}\n`)
    const session = createTestNoteSession({
      path: DAILY,
      content: `- ${PLACEHOLDER_LINK}\n- unsaved typing\n`,
    })
    openDocuments.register({ session })
    const write = vi.spyOn(noteFile, 'write')

    await repair.sweep(3)

    expect(session.content()).toBe(`- ${TITLED_LINK}\n- unsaved typing\n`)
    expect(write).not.toHaveBeenCalled()
  })

  it('skips an open daily that cannot take the edit', async () => {
    await addCapture()
    const daily = `- ${PLACEHOLDER_LINK}\n`
    noteFile.set(DAILY, daily)
    const session = createTestNoteSession({ path: DAILY, content: daily, accepts: false })
    openDocuments.register({ session })

    await repair.sweep(3)

    expect(session.content()).toBe(daily)
    expect(noteFile.files().get(DAILY)).toBe(daily)
  })

  it('keeps going after a daily changed underneath the write', async () => {
    await addCapture()
    const { identity, source } = await captureNote({
      capturedAt: new Date(2026, 5, 12, 9, 0, 0, 0),
    })
    noteFile.set(identity.notePath, source)
    noteFile.set(DAILY, `- ${PLACEHOLDER_LINK}\n`)
    noteFile.set('daily/2026-06-12.md', `- [[${identity.base}|www.instagram.com]]\n`)
    const read = noteFile.read.bind(noteFile)
    vi.spyOn(noteFile, 'read').mockImplementation(async (path, generation) => {
      const current = await read(path, generation)
      if (path === DAILY) {
        noteFile.set(DAILY, `${current}- typed meanwhile\n`)
      }
      return current
    })

    await repair.sweep(3)

    expect(noteFile.files().get(DAILY)).toBe(`- ${PLACEHOLDER_LINK}\n- typed meanwhile\n`)
    expect(noteFile.files().get('daily/2026-06-12.md')).toBe(
      `- [[${identity.base}|Kitchen design decisions part 2]]\n`,
    )
  })
})
