import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestCoreServices, createTestIpcBridgeService } from '@reflect/core/testing'
import type { TestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { NoteVersionsAction } from './note-versions-action.tsx'

const PATH = 'notes/a.md'
const NEWER = { name: '2000-phone.md', modifiedMs: 2000, device: 'phone', size: 5 }
const OLDER = { name: '1000-laptop.md', modifiedMs: 1000, device: 'laptop', size: 2048 }

let versions: (typeof NEWER)[]
let app: TestCoreServices

async function renderAction() {
  return await renderInApp(<NoteVersionsAction path={PATH} />, {
    app,
    graph: { root: '/g', name: 'g', generation: 7 },
  })
}

beforeEach(() => {
  versions = [NEWER, OLDER]
  app = createTestCoreServices({
    ipc: createTestIpcBridgeService({
      commands: {
        conflict_archive_list: () => versions,
        conflict_archive_read: (args) => `text of ${String(args.name)}`,
      },
    }),
  })
})

describe('NoteVersionsAction', () => {
  it('lists the versions only after the dialog opens', async () => {
    const view = await renderAction()
    expect(app.ipc.calls().map(({ command }) => command)).not.toContain('conflict_archive_list')

    await userEvent.click(view.getByRole('button', { name: /Earlier versions/ }))
    await expect.element(view.getByText(/phone, 5 B/)).toBeInTheDocument()
    await expect.element(view.getByText(/laptop, 2\.0 KB/)).toBeInTheDocument()
  })

  it('shows a version read-only and restores it with a write', async () => {
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Earlier versions/ }))
    await userEvent.click(view.getByRole('button', { name: /laptop/ }))
    await expect.element(view.getByText('text of 1000-laptop.md')).toBeInTheDocument()

    await userEvent.click(view.getByRole('button', { name: 'Restore this version' }))
    await expect
      .poll(() => app.noteFile.writes())
      .toEqual([{ path: PATH, contents: 'text of 1000-laptop.md', generation: 7 }])
    expect(app.progress.started().map((operation) => operation.label)).toContain(
      'Restoring version',
    )
  })

  it('renders nothing once the list turns out empty', async () => {
    versions = []
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Earlier versions/ }))
    await expect
      .element(view.getByRole('button', { name: /Earlier versions/ }))
      .not.toBeInTheDocument()
  })
})
