import { act } from '@/test-utils/act.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError, createAttachmentService, type AttachmentService } from '@reflect/core'
import {
  createTestCoreServices,
  createTestAssetStoreService,
  createTestAttachmentService,
  createTestClockService,
  createTestFileChangeService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestPlatformService,
  type TestAttachmentService,
  type TestAttachmentServiceOptions,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useAssetPersistence, type AssetPersistence } from './use-asset-persistence.ts'

let persistence: AssetPersistence | null = null
// The app of the latest `renderPersistence`; the attachment services read its graph.
let core: ReturnType<typeof createTestCoreServices<{ attachments: AttachmentService }>>
const graphSession = { getState: () => core.graphSession.getState() }
// The attachment service of the next `renderPersistence`.
let attachmentService: AttachmentService = createTestAttachmentService({ graphSession })

function renderPersistence({
  generation,
  path = 'notes/a.md',
}: {
  generation: number | null
  path?: string
}) {
  core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    attachments: attachmentService,
  })
  return renderHookInApp(
    ({ path }: { path: string } = { path: 'notes/a.md' }) => {
      persistence = useAssetPersistence(path)
    },
    {
      initialProps: { path },
      core,
      graph: generation === null ? null : { generation },
    },
  )
}

function installAttachments(options?: TestAttachmentServiceOptions): TestAttachmentService {
  const attachments = createTestAttachmentService({ ...options, graphSession })
  attachmentService = attachments
  return attachments
}

function fileOf(name: string, type: string): File {
  return new File([new Uint8Array(16)], name, { type })
}

afterEach(() => {
  attachmentService = createTestAttachmentService({ graphSession })
  persistence = null
})

describe('useAssetPersistence', () => {
  it('resolves against the note it renders and its graph session', async () => {
    installAttachments({ catalog: [{ path: 'attachments/report.pdf', size: 42 }] })
    await renderPersistence({ generation: 3, path: 'Projects/Plan.md' })

    expect(persistence!.resolveImageUrl('../attachments/garden.png')).toBe(
      `reflect-asset://localhost/${encodeURIComponent('3/attachments/garden.png')}`,
    )
    expect(persistence!.resolveAssetOpenPath('../attachments/report.pdf')).toBe(
      'attachments/report.pdf',
    )
    expect(
      persistence!.resolveFileLink({ href: '../attachments/report.pdf', label: '', title: '' }),
    ).toBe(true)
    await expect(persistence!.resolveFileInfo('../attachments/report.pdf')).resolves.toEqual({
      size: 42,
    })
    expect(
      persistence!.resolveWikiEmbed({
        target: 'Deep Work',
        display: '',
        width: null,
        height: null,
      }),
    ).toEqual({ kind: 'note' })
  })

  it('opens attachments in the graph session', async () => {
    const attachments = installAttachments()
    await renderPersistence({ generation: 3 })

    await act(async () => {
      await persistence!.openAsset('assets/q3-report.pdf')
    })

    expect(attachments.opened()).toEqual(['assets/q3-report.pdf'])
  })

  it('declines without a graph session', async () => {
    const attachments = installAttachments()
    await renderPersistence({ generation: null })

    let saved: string | null = 'sentinel'
    await act(async () => {
      saved = await persistence!.saveFile(fileOf('a.pdf', 'application/pdf'))
      await persistence!.openAsset('assets/q3-report.pdf')
    })

    expect(saved).toBeNull()
    expect(attachments.saves()).toEqual([])
    expect(attachments.opened()).toEqual([])
    expect(persistence!.resolveImageUrl('assets/cat.png')).toBeUndefined()
    expect(persistence!.resolveAssetOpenPath('assets/cat.png')).toBeNull()
    await expect(persistence!.resolveFileInfo('assets/cat.png')).resolves.toBeUndefined()
  })

  it('shows the latest failed save until the next success', async () => {
    const attachments = installAttachments()
    await renderPersistence({ generation: 3 })

    attachments.failSaves({ kind: 'image', message: 'disk full' })
    await act(async () => {
      await expect(persistence!.saveFile(fileOf('a.png', 'image/png'))).resolves.toBeNull()
    })
    expect(persistence!.saveError).toEqual({ kind: 'image', message: 'disk full' })

    attachments.failSaves(null)
    await act(async () => {
      await expect(persistence!.saveFile(fileOf('b.pdf', 'application/pdf'))).resolves.toBe(
        'assets/b.pdf',
      )
    })
    expect(persistence!.saveError).toBeNull()
    expect(attachments.saves()).toMatchObject([{ name: 'b.pdf', generation: 3 }])
  })

  it('drops a failure that lands after the note switched', async () => {
    const upload = Promise.withResolvers<string>()
    const clock = createTestClockService()
    attachmentService = createAttachmentService({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: () => upload.promise,
      }),
      noteFile: createTestNoteFileService(),
      fileChanges: createTestFileChangeService(),
      progress: createTestProgressPort(),
      clock,
      platform: createTestPlatformService(),
      graphSession,
    })
    const view = await renderPersistence({ generation: 3, path: 'notes/a.md' })

    let savePromise: Promise<string | null> | null = null
    await act(() => {
      savePromise = persistence!.saveFile(fileOf('slow.pdf', 'application/pdf'))
    })

    // The user moves on; the save then fails for the note they left.
    await view.rerender({ path: 'notes/b.md' })
    await act(async () => {
      upload.reject(new AppError('io', 'late failure'))
      await savePromise
    })

    await expect(savePromise).resolves.toBeNull()
    expect(persistence!.saveError).toBeNull()
  })
})
