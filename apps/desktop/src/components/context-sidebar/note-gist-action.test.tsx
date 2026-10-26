import { userEvent } from 'vitest/browser'
import type { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { GistPublishService, NoteRow } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { queryKeys } from '@/lib/query-client.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NoteGistAction } from './note-gist-action.tsx'

const GIST_URL = 'https://gist.github.com/alex/g1'

// What the app's fakes answer; each test sets them before `renderAction`.
let connected: boolean
let row: NoteRow | null

// The services of the app under test; created fresh for each test.
let core: TestCoreServices
let publish: MockInstance<GistPublishService['publish']>
let unpublish: MockInstance<GistPublishService['unpublish']>

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

async function renderAction() {
  if (connected) {
    await core.githubAuth.save({ kind: 'pat', token: 'ghp_test' })
  }
  return await renderInApp(<NoteGistAction path="notes/a.md" />, {
    core,
    graph: { root: '/g', name: 'g', generation: 7 },
  })
}

/**
 * Both reads behind the action have answered: what renders now is final.
 */
async function waitForReads(queryClient: QueryClient): Promise<void> {
  await vi.waitFor(() => {
    expect(core.githubAuth.getState().connected).toBe(connected)
    expect(queryClient.getQueryData(queryKeys.index.note('/g', 'notes/a.md'))).toEqual(row)
  })
}

beforeEach(() => {
  connected = true
  row = null
  core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  vi.spyOn(core.indexQuery, 'getNote').mockImplementation(() => Promise.resolve(row ?? undefined))
  publish = vi.spyOn(core.gistPublish, 'publish').mockResolvedValue({ url: GIST_URL, stale: false })
  unpublish = vi.spyOn(core.gistPublish, 'unpublish').mockResolvedValue({ url: null, stale: false })
})

describe('NoteGistAction', () => {
  it('renders nothing without a GitHub connection', async () => {
    connected = false
    const view = await renderAction()
    await waitForReads(view.queryClient)
    expect(view.getByRole('button').query()).toBeNull()
  })

  it('renders nothing for a private note', async () => {
    row = noteRow({ isPrivate: true })
    const view = await renderAction()
    await waitForReads(view.queryClient)
    expect(view.getByRole('button').query()).toBeNull()
  })

  it('offers Share with private link for an unpublished note (even before its row exists)', async () => {
    const view = await renderAction()
    await expect
      .element(view.getByRole('button', { name: /Share with private link/ }))
      .toBeInTheDocument()
  })

  it('offers Unpublish link once the note carries a gist', async () => {
    row = noteRow({ gistUrl: 'https://gist.github.com/alex/g1' })
    const view = await renderAction()
    await expect.element(view.getByRole('button', { name: /Unpublish link/ })).toBeInTheDocument()
  })

  it('publishes the open note on click', async () => {
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Share with private link/ }))
    expect(publish).toHaveBeenCalledWith('notes/a.md')
  })

  it('copies the gist link and confirms after the publish', async () => {
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Share with private link/ }))

    await vi.waitFor(() => expect(view.appServices.clipboard.writes()).toEqual([GIST_URL]))
    expect(core.progress.started().map((operation) => operation.label)).toContain(
      'Gist link copied',
    )
  })

  it('reports a failed copy and keeps the publish', async () => {
    const view = await renderAction()
    view.appServices.clipboard.failWith(new Error('denied'))
    await userEvent.click(view.getByRole('button', { name: /Share with private link/ }))

    await vi.waitFor(() => {
      expect(core.progress.findByLabel('Copying the gist link')).toMatchObject({
        status: 'failed',
        message: 'denied',
      })
    })
  })

  it('unpublishes the open note on click once it carries a gist', async () => {
    row = noteRow({ gistUrl: 'https://gist.github.com/alex/g1' })
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Unpublish link/ }))
    expect(unpublish).toHaveBeenCalledWith('notes/a.md')
  })

  it('reflects an optimistic publish as Republish before the index catches up', async () => {
    // The overlay is what the publish writes on success (its contract is
    // covered in note-gist.test.ts); given one, the label flips without waiting
    // on the index.
    core.noteRows.setOverlay('notes/a.md', 7, { gistUrl: 'https://gist.github.com/alex/g1' })
    const view = await renderAction()
    await expect.element(view.getByRole('button', { name: /Unpublish link/ })).toBeInTheDocument()
  })

  it('stays on Publish when the publish failed (already surfaced elsewhere)', async () => {
    publish.mockResolvedValue(null)
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Share with private link/ }))

    await expect
      .element(view.getByRole('button', { name: /Share with private link/ }))
      .toBeInTheDocument()
  })
})
