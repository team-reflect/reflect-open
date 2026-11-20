import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestCoreServices,
  createTestDatabaseService,
  type TestCoreServices,
} from '@reflect/core/testing'
import { createTestAppServices, type TestAppServices } from '../testing/services.ts'
import { copyNoteDeepLink, copyNotePath, publishGistAndCopyLink } from './clipboard-actions.ts'

let core: TestCoreServices
let appLayer: TestAppServices

beforeEach(() => {
  core = createTestCoreServices({ database: createTestDatabaseService() })
  appLayer = createTestAppServices(core)
})

afterEach(() => {
  core.database.close()
})

describe('clipboard actions', () => {
  it('copyNoteDeepLink copies the note link and confirms through operations', async () => {
    core.graphSession.setGraph({ generation: 1 })
    const deepLinkFor = vi.spyOn(core.noteActions, 'deepLinkFor').mockResolvedValue('reflect://x')
    await copyNoteDeepLink(core, appLayer, 'notes/a.md')
    expect(deepLinkFor).toHaveBeenCalledWith('notes/a.md')
    expect(appLayer.clipboard.writes()).toEqual(['reflect://x'])
    expect(core.progress.started()).toMatchObject([{ label: 'Deep link copied', ended: true }])
  })

  it('copyNoteDeepLink reports a failure to build the link', async () => {
    core.graphSession.setGraph({ generation: 1 })
    vi.spyOn(core.noteActions, 'deepLinkFor').mockRejectedValue(new Error('disk full'))
    await copyNoteDeepLink(core, appLayer, 'notes/a.md')
    expect(appLayer.clipboard.writes()).toEqual([])
    expect(core.progress.snapshot()).toMatchObject([
      { label: 'Copying deep link', status: 'failed', message: 'disk full' },
    ])
  })

  it('copyNoteDeepLink reports a clipboard failure', async () => {
    core.graphSession.setGraph({ generation: 1 })
    vi.spyOn(core.noteActions, 'deepLinkFor').mockResolvedValue('reflect://x')
    appLayer.clipboard.failWith(new Error('denied'))
    await copyNoteDeepLink(core, appLayer, 'notes/a.md')
    expect(core.progress.snapshot()).toMatchObject([
      { label: 'Copying deep link', status: 'failed', message: 'denied' },
    ])
  })

  it('copyNoteDeepLink does nothing without an open graph', async () => {
    core.graphSession.setGraph(null)
    const deepLinkFor = vi.spyOn(core.noteActions, 'deepLinkFor').mockResolvedValue('reflect://x')
    await copyNoteDeepLink(core, appLayer, 'notes/a.md')
    expect(deepLinkFor).not.toHaveBeenCalled()
    expect(appLayer.clipboard.writes()).toEqual([])
    expect(core.progress.get()).toEqual([])
  })

  it('copyNotePath copies the absolute note path and confirms through operations', async () => {
    core.graphSession.setGraph({ generation: 1 })
    const absolutePathFor = vi
      .spyOn(core.noteActions, 'absolutePathFor')
      .mockResolvedValue('/g/notes/a.md')
    await copyNotePath(core, appLayer, 'notes/a.md')
    expect(absolutePathFor).toHaveBeenCalledWith('notes/a.md')
    expect(appLayer.clipboard.writes()).toEqual(['/g/notes/a.md'])
    expect(core.progress.started()).toMatchObject([{ label: 'Note path copied', ended: true }])
  })

  it('copyNotePath fails loudly when no graph is open', async () => {
    core.graphSession.setGraph(null)
    await copyNotePath(core, appLayer, 'notes/a.md')
    expect(appLayer.clipboard.writes()).toEqual([])
    expect(core.progress.snapshot()).toMatchObject([
      { label: 'Copying note path', status: 'failed', message: 'No graph is open' },
    ])
  })

  it('copyNotePath reports a clipboard failure', async () => {
    core.graphSession.setGraph({ generation: 1 })
    vi.spyOn(core.noteActions, 'absolutePathFor').mockResolvedValue('/g/notes/a.md')
    appLayer.clipboard.failWith(new Error('denied'))
    await copyNotePath(core, appLayer, 'notes/a.md')
    expect(core.progress.snapshot()).toMatchObject([
      { label: 'Copying note path', status: 'failed', message: 'denied' },
    ])
  })

  it('publishGistAndCopyLink publishes, copies the link, and confirms through operations', async () => {
    core.graphSession.setGraph({ generation: 1 })
    const publish = vi
      .spyOn(core.gistPublish, 'publish')
      .mockResolvedValue({ url: 'https://gist.github.com/g1', stale: false })
    await publishGistAndCopyLink(core, appLayer, 'notes/a.md')
    expect(publish).toHaveBeenCalledWith('notes/a.md')
    expect(appLayer.clipboard.writes()).toEqual(['https://gist.github.com/g1'])
    expect(core.progress.started()).toMatchObject([{ label: 'Gist link copied', ended: true }])
  })

  it('publishGistAndCopyLink reports a failed copy without reading as a failed publish', async () => {
    vi.spyOn(core.gistPublish, 'publish').mockResolvedValue({
      url: 'https://gist.github.com/g1',
      stale: false,
    })
    appLayer.clipboard.failWith(new Error('Document is not focused'))
    await publishGistAndCopyLink(core, appLayer, 'notes/a.md')
    expect(core.progress.snapshot()).toMatchObject([
      { label: 'Copying the gist link', status: 'failed', message: 'Document is not focused' },
    ])
  })

  it('publishGistAndCopyLink copies nothing when the publish failed', async () => {
    vi.spyOn(core.gistPublish, 'publish').mockResolvedValue(null)
    await publishGistAndCopyLink(core, appLayer, 'notes/a.md')
    expect(appLayer.clipboard.writes()).toEqual([])
  })
})
