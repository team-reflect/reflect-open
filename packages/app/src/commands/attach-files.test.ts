import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDatabaseService,
  createTestCoreServices,
  type TestCoreServices,
} from '@reflect/core/testing'
import type { AttachmentInsertTarget } from '@reflect/core'
import { createTestAppServices, type TestAppServices } from '../testing/services.ts'
import { attachFilesToNote } from './attach-files.ts'
import { noop } from '@ocavue/utils'

let core: TestCoreServices
let appLayer: TestAppServices
// The mounted note editors, by note path.
const editors = new Map<string, AttachmentInsertTarget>()

beforeEach(() => {
  core = createTestCoreServices({ database: createTestDatabaseService() })
  appLayer = createTestAppServices(core)
  core.graphSession.setGraph({ generation: 4 })
})

afterEach(() => {
  core.database.close()
  editors.clear()
})

function attachToPlan(): Promise<void> {
  return attachFilesToNote(core, appLayer.dialog, () => editors.get('notes/plan.md') ?? null)
}

function editorHandle(): AttachmentInsertTarget {
  return { insertMarkdown: noop, focus: noop }
}

describe('attachFilesToNote', () => {
  it("attaches the picked files into the note's editor, looked up on every call", async () => {
    const handle = editorHandle()
    editors.set('notes/plan.md', handle)
    appLayer.dialog.setFiles(['/tmp/a.pdf'])

    await attachToPlan()

    expect(appLayer.dialog.calls()).toEqual([
      { kind: 'files', options: { multiple: true, title: 'Attach files' } },
    ])
    const [request] = core.attachments.attachRequests()
    expect(request?.sources).toEqual(['/tmp/a.pdf'])
    expect(request?.findEditor()).toBe(handle)
    editors.delete('notes/plan.md')
    expect(request?.findEditor()).toBeNull()
  })

  it('does nothing without an editor, a graph session or a pick', async () => {
    appLayer.dialog.setFiles(['/tmp/a.pdf'])
    await attachToPlan()
    const handle = editorHandle()
    editors.set('notes/plan.md', handle)
    core.graphSession.setGraph(null)
    await attachToPlan()
    core.graphSession.setGraph({ generation: 4 })
    appLayer.dialog.setFiles(null)
    await attachToPlan()
    editors.delete('notes/plan.md')

    expect(core.attachments.attachRequests()).toEqual([])
    expect(appLayer.dialog.calls()).toHaveLength(1)
  })
})
