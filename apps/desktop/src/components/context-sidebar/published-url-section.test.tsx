import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { MIN_VISIBLE_MS } from '@reflect/app'
import type { GistPublishService, NoteRow } from '@reflect/core'
import {
  createTestAppServices,
  createTestOperationsService,
  type TestClipboardService,
  type TestOpenerService,
  type TestOperationsService,
} from '@reflect/app/testing'
import { createTestCoreServices } from '@reflect/core/testing'
import { queryKeys } from '@/lib/query-client.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { PublishedUrlSection } from './published-url-section.tsx'

// What the index answers for the note; each test sets it before `renderSection`.
let row: NoteRow | null

// The services of the rendered app; set by `renderSection`.
let clipboard: TestClipboardService
let opener: TestOpenerService
let operations: TestOperationsService
let publish: MockInstance<GistPublishService['publish']>
// Scripts the clipboard of the next `renderSection`.
let clipboardFailure: Error | null

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

async function renderSection(path = 'notes/a.md') {
  operations = createTestOperationsService()
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    progress: operations,
  })
  vi.spyOn(app.indexQuery, 'getNote').mockImplementation(() => Promise.resolve(row ?? undefined))
  publish = vi
    .spyOn(app.gistPublish, 'publish')
    .mockResolvedValue({ url: 'https://gist.github.com/alex/g1', stale: false })
  const appLayer = createTestAppServices(app)
  ;({ clipboard, opener } = appLayer)
  if (clipboardFailure !== null) {
    clipboard.failWith(clipboardFailure)
  }
  return await renderInApp(<PublishedUrlSection path={path} />, {
    app,
    appServices: appLayer,
    graph: { root: '/g', name: 'g', generation: 7 },
  })
}

beforeEach(() => {
  row = null
  clipboardFailure = null
})

describe('PublishedUrlSection', () => {
  it('renders nothing for an unpublished note', async () => {
    const view = await renderSection()
    await vi.waitFor(() =>
      expect(view.queryClient.getQueryData(queryKeys.index.note('/g', 'notes/a.md'))).toBeNull(),
    )
    expect(view.getByText('Published URL').query()).toBeNull()
  })

  it('shows the published gist URL for a published note', async () => {
    const url = 'https://gist.github.com/alex/g1'
    row = noteRow({ gistUrl: url })

    const view = await renderSection()
    await expect.element(view.getByText('Published URL')).toBeInTheDocument()
    await expect.element(view.getByRole('link', { name: url })).toHaveAttribute('href', url)
  })

  it('opens the published URL through the native opener', async () => {
    const url = 'https://gist.github.com/alex/g1'
    row = noteRow({ gistUrl: url })

    const view = await renderSection()
    await userEvent.click(view.getByRole('link', { name: url }))
    await vi.waitFor(() => expect(opener.openedUrls()).toEqual([url]))
  })

  it('copies the published URL', async () => {
    const url = 'https://gist.github.com/alex/g1'
    row = noteRow({ gistUrl: url })

    const view = await renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Copy published URL' }))

    await vi.waitFor(() => expect(clipboard.writes()).toEqual([url]))
    await vi.waitFor(() => expect(operations.findByLabel('Published URL copied')).toBeDefined())
    await operations.clock.advance(MIN_VISIBLE_MS)
    expect(operations.getAll()).toEqual([])
  })

  it('updates the published gist from the URL section icon', async () => {
    const url = 'https://gist.github.com/alex/g1'
    row = noteRow({ gistUrl: url })

    const view = await renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Update published gist' }))

    expect(publish).toHaveBeenCalledWith('notes/a.md')
  })

  it('shows the stale update affordance beside the copy button', async () => {
    const url = 'https://gist.github.com/alex/g1'
    row = noteRow({ gistUrl: url, gistStale: true })

    const view = await renderSection()
    await expect
      .element(view.getByRole('button', { name: 'Copy published URL' }))
      .toBeInTheDocument()
    await expect
      .element(view.getByRole('button', { name: 'Update published gist' }))
      .toBeInTheDocument()
    expect(
      view.getByRole('button', { name: 'Update published gist' }).element().className,
    ).toContain('text-accent')
  })

  it('surfaces copy failures through the operations status', async () => {
    const url = 'https://gist.github.com/alex/g1'
    clipboardFailure = new Error('Document is not focused')
    row = noteRow({ gistUrl: url })

    const view = await renderSection()
    await userEvent.click(view.getByRole('button', { name: 'Copy published URL' }))

    await vi.waitFor(() =>
      expect(operations.findByLabel('Copying the published URL')?.status).toBe('failed'),
    )
  })
})
