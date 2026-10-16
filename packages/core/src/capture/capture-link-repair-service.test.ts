import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureIdentity } from './capture-identity.ts'
import {
  createCaptureLinkRepairService,
  withRepairedCaptureLinks,
  type CaptureLinkRepairService,
} from './capture-link-repair-service.ts'
import { captureNoteSource } from './capture-note.ts'
import {
  createOpenDocumentsService,
  type OpenDocumentsService,
} from '../documents/open-documents-service.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import {
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
  } = {},
): Promise<string> {
  const source = await captureNoteSource(
    {
      version: 1,
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      url: 'https://www.instagram.com/reel/DdEw84HR2CV/',
      title: '',
      capturedAt: CAPTURED_AT.toISOString(),
      source: 'ios-share',
    },
    IDENTITY,
    { hasScreenshot: false, status: options.status ?? 'done' },
  )
  const retitled = source.replace(
    '# www.instagram.com',
    `# ${options.title ?? 'Kitchen design decisions part 2'}`,
  )
  return options.extra === undefined ? retitled : upsertFrontmatter(retitled, options.extra)
}

describe('withRepairedCaptureLinks', () => {
  const repairs = new Map([
    [IDENTITY.base, { placeholder: 'www.instagram.com', title: 'Costs $& more' }],
  ])

  it('rewrites every placeholder link of the capture and keeps `$` literal', () => {
    const daily = `- ${PLACEHOLDER_LINK}\n- again ${PLACEHOLDER_LINK}\n`
    expect(withRepairedCaptureLinks(daily, repairs)).toBe(
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
    expect(withRepairedCaptureLinks(daily, repairs)).toBe(daily)
  })

  it('is idempotent', () => {
    const once = withRepairedCaptureLinks(`- ${PLACEHOLDER_LINK}\n`, repairs)
    expect(withRepairedCaptureLinks(once, repairs)).toBe(once)
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
      logger: createTestLoggerService(),
    })
  })

  it('rewrites a placeholder link to the finished capture title', async () => {
    noteFile.set(IDENTITY.notePath, await captureNote())
    noteFile.set(DAILY, `## [[Links]]\n\n- ${PLACEHOLDER_LINK}\n`)

    await repair.repair([DAILY], 3)

    expect(noteFile.files().get(DAILY)).toBe(`## [[Links]]\n\n- ${TITLED_LINK}\n`)
  })

  it.each([
    ['a pending capture', { status: 'pending' as const }],
    ['a skipped capture', { status: 'skipped' as const }],
    ['a capture with a retitle in progress', { extra: { captureDailyFromTitle: 'x' } }],
    ['a private capture', { extra: { private: true } }],
    ['a capture still titled with its placeholder', { title: 'www.instagram.com' }],
  ])('leaves the link of %s alone', async (_name, options) => {
    noteFile.set(IDENTITY.notePath, await captureNote(options))
    const daily = `- ${PLACEHOLDER_LINK}\n`
    noteFile.set(DAILY, daily)

    await repair.repair([DAILY], 3)

    expect(noteFile.files().get(DAILY)).toBe(daily)
  })

  it('leaves a private daily and user-written link text alone', async () => {
    noteFile.set(IDENTITY.notePath, await captureNote())
    const privateDaily = `---\nprivate: true\n---\n\n- ${PLACEHOLDER_LINK}\n`
    const userDaily = `- [[${IDENTITY.base}|my own words]]\n`
    noteFile.set(DAILY, privateDaily)
    noteFile.set('daily/2026-06-12.md', userDaily)

    await repair.repair([DAILY, 'daily/2026-06-12.md'], 3)

    expect(noteFile.files().get(DAILY)).toBe(privateDaily)
    expect(noteFile.files().get('daily/2026-06-12.md')).toBe(userDaily)
  })

  it('edits an open daily through its session', async () => {
    noteFile.set(IDENTITY.notePath, await captureNote())
    noteFile.set(DAILY, `- ${PLACEHOLDER_LINK}\n`)
    const session = createTestNoteSession({
      path: DAILY,
      content: `- ${PLACEHOLDER_LINK}\n- unsaved typing\n`,
    })
    openDocuments.register({ session })
    const write = vi.spyOn(noteFile, 'write')

    await repair.repair([DAILY], 3)

    expect(session.content()).toBe(`- ${TITLED_LINK}\n- unsaved typing\n`)
    expect(write).not.toHaveBeenCalled()
  })

  it('skips an open daily that cannot take the edit', async () => {
    noteFile.set(IDENTITY.notePath, await captureNote())
    const daily = `- ${PLACEHOLDER_LINK}\n`
    noteFile.set(DAILY, daily)
    const session = createTestNoteSession({ path: DAILY, content: daily, accepts: false })
    openDocuments.register({ session })

    await repair.repair([DAILY], 3)

    expect(session.content()).toBe(daily)
    expect(noteFile.files().get(DAILY)).toBe(daily)
  })

  it('keeps going after a daily changed underneath the write', async () => {
    noteFile.set(IDENTITY.notePath, await captureNote())
    noteFile.set(DAILY, `- ${PLACEHOLDER_LINK}\n`)
    noteFile.set('daily/2026-06-12.md', `- ${PLACEHOLDER_LINK}\n`)
    const read = noteFile.read.bind(noteFile)
    vi.spyOn(noteFile, 'read').mockImplementation(async (path, generation) => {
      const source = await read(path, generation)
      if (path === DAILY) {
        noteFile.set(DAILY, `${source}- typed meanwhile\n`)
      }
      return source
    })

    await repair.repair([DAILY, 'daily/2026-06-12.md'], 3)

    expect(noteFile.files().get(DAILY)).toBe(`- ${PLACEHOLDER_LINK}\n- typed meanwhile\n`)
    expect(noteFile.files().get('daily/2026-06-12.md')).toBe(`- ${TITLED_LINK}\n`)
  })

  it('lists the dailies of finished captures that have a real title', async () => {
    noteFile.set(IDENTITY.notePath, await captureNote())
    noteFile.set(
      OTHER.notePath,
      (await captureNote({ status: 'pending' })).replace(IDENTITY.base, OTHER.base),
    )
    noteFile.set('notes/plain.md', '# Plain\n')

    expect(await repair.candidateDailies(3)).toEqual([DAILY])
  })
})
