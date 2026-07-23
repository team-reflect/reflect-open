import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { expectLocatorToHaveCount } from '@/test-utils/expect'

interface SummaryFixture {
  importedFiles: number
  skippedFiles: number
  downloadedAssets: number
  failedAssetDownloads: number
  renamedFiles: number
  mergedFiles: number
  changedPaths: string[]
}

interface ProgressFixture {
  stage: 'downloading' | 'writing'
  done: number
  total: number
}

const importReflectV1Zip = vi.hoisted(() => vi.fn<() => Promise<SummaryFixture>>())
const cancelReflectV1Import = vi.hoisted(() => vi.fn(async () => {}))
const markReflectV1ImportOwnWrites = vi.hoisted(() => vi.fn())
const progressHandlers = vi.hoisted(() => new Set<(progress: ProgressFixture) => void>())
const refreshIndex = vi.hoisted(() => vi.fn())

vi.mock('@reflect/core', () => ({
  importReflectV1Zip,
  cancelReflectV1Import,
  markReflectV1ImportOwnWrites,
  subscribeImportProgress: (handler: (progress: ProgressFixture) => void) => {
    progressHandlers.add(handler)
    return Promise.resolve(() => progressHandlers.delete(handler))
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ refreshIndex }),
}))

const { V1ImportProvider, useV1Import } = await import('./v1-import-provider')

function summary(overrides: Partial<SummaryFixture> = {}): SummaryFixture {
  return {
    importedFiles: 2,
    skippedFiles: 1,
    downloadedAssets: 0,
    failedAssetDownloads: 0,
    renamedFiles: 0,
    mergedFiles: 0,
    changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    ...overrides,
  }
}

function emitProgress(progress: ProgressFixture): void {
  for (const handler of [...progressHandlers]) {
    handler(progress)
  }
}

function Probe(): ReactElement {
  const { state, startImport } = useV1Import()
  return (
    <button type="button" onClick={() => startImport('/tmp/reflect-v1.zip')}>
      start ({state.phase})
    </button>
  )
}

function renderProvider(graph = { root: '/graphs/notes', name: 'Notes', generation: 42 }) {
  return render(
    <V1ImportProvider graph={graph}>
      <Probe />
    </V1ImportProvider>,
  )
}

function startButton() {
  return page.getByRole('button', { name: /start/ })
}

// Auto-cleanup unmounts the previous test's provider at the START of the next
// test (a running import then calls `cancelReflectV1Import`), so the mock
// reset must come after it, not in afterEach.
beforeEach(() => {
  vi.clearAllMocks()
  progressHandlers.clear()
  importReflectV1Zip.mockResolvedValue(summary())
})

describe('V1ImportProvider', () => {
  it('runs the import and reports the outcome in the dialog', async () => {
    let finish: (value: SummaryFixture) => void = () => {}
    importReflectV1Zip.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await renderProvider()

    await startButton().click()

    await expect.element(page.getByText('Importing from Reflect V1')).toBeInTheDocument()
    await expect.element(page.getByText('Reading the export…')).toBeInTheDocument()
    expect(importReflectV1Zip).toHaveBeenCalledWith('/tmp/reflect-v1.zip', 42)

    emitProgress({ stage: 'downloading', done: 3, total: 8 })
    await expect.element(page.getByText('Downloading attachments… 3 of 8')).toBeInTheDocument()

    emitProgress({ stage: 'writing', done: 10, total: 40 })
    await expect.element(page.getByText('Adding notes… 10 of 40')).toBeInTheDocument()

    finish(summary({ mergedFiles: 1, renamedFiles: 1 }))
    await expect.element(page.getByText('Import complete')).toBeInTheDocument()
    await expect
      .element(
        page.getByText(
          '2 files imported, 1 daily note merged, 1 renamed to avoid a name clash, 1 already present.',
        ),
      )
      .toBeInTheDocument()
    expect(markReflectV1ImportOwnWrites).toHaveBeenCalledTimes(1)
    expect(refreshIndex).toHaveBeenCalledTimes(1)

    await page.getByRole('button', { name: 'Done' }).click()
    await expectLocatorToHaveCount(page.getByText('Import complete'), 0)
  })

  it('cannot be dismissed while the import runs', async () => {
    importReflectV1Zip.mockImplementationOnce(() => new Promise(() => {}))
    await renderProvider()

    await startButton().click()
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()

    expect(page.getByRole('button', { name: 'Close' }).query()).toBeNull()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByText('Importing from Reflect V1')).toBeInTheDocument()
  })

  it('cancels the running import and settles back to idle', async () => {
    let reject: (reason: Error) => void = () => {}
    importReflectV1Zip.mockImplementationOnce(
      () =>
        new Promise((_, rejectPromise) => {
          reject = rejectPromise
        }),
    )
    await renderProvider()

    await startButton().click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    expect(cancelReflectV1Import).toHaveBeenCalledTimes(1)
    await expect.element(page.getByRole('button', { name: 'Cancelling…' })).toBeInTheDocument()

    reject(new Error('import cancelled'))
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
    expect(page.getByText('Import failed').query()).toBeNull()
    expect(markReflectV1ImportOwnWrites).not.toHaveBeenCalled()
  })

  it('hides Cancel once writing starts (nothing can be aborted safely)', async () => {
    importReflectV1Zip.mockImplementationOnce(() => new Promise(() => {}))
    await renderProvider()

    await startButton().click()
    await expect
      .element(page.getByRole('button', { name: 'Cancel', exact: true }))
      .toBeInTheDocument()

    emitProgress({ stage: 'writing', done: 1, total: 4 })
    await expectLocatorToHaveCount(page.getByRole('button', { name: 'Cancel' }), 0)
  })

  it('surfaces failures with the native message', async () => {
    importReflectV1Zip.mockRejectedValueOnce(new Error('could not read the zip'))
    await renderProvider()

    await startButton().click()

    await expect.element(page.getByText('Import failed')).toBeInTheDocument()
    await expect.element(page.getByText('could not read the zip')).toBeInTheDocument()
    expect(refreshIndex).not.toHaveBeenCalled()

    await page.getByRole('button', { name: 'Close' }).click()
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('drops the result when the graph switched mid-import', async () => {
    let finish: (value: SummaryFixture) => void = () => {}
    importReflectV1Zip.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const view = await renderProvider()

    await startButton().click()
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()

    await view.rerender(
      <V1ImportProvider graph={{ root: '/graphs/other', name: 'Other', generation: 43 }}>
        <Probe />
      </V1ImportProvider>,
    )
    finish(summary())

    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
    expect(markReflectV1ImportOwnWrites).not.toHaveBeenCalled()
    expect(refreshIndex).not.toHaveBeenCalled()
  })

  it('cancels and drops the result when the workspace unmounts mid-import', async () => {
    let finish: (value: SummaryFixture) => void = () => {}
    importReflectV1Zip.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const view = await renderProvider()

    await startButton().click()
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()

    await view.unmount()
    expect(cancelReflectV1Import).toHaveBeenCalledTimes(1)

    finish(summary())
    await vi.waitFor(() => expect(importReflectV1Zip).toHaveBeenCalledTimes(1))
    expect(markReflectV1ImportOwnWrites).not.toHaveBeenCalled()
    expect(refreshIndex).not.toHaveBeenCalled()
  })

  it('summarizes failed attachment downloads', async () => {
    importReflectV1Zip.mockResolvedValueOnce(
      summary({
        importedFiles: 12,
        skippedFiles: 0,
        downloadedAssets: 140,
        failedAssetDownloads: 1,
        changedPaths: ['notes/a.md'],
      }),
    )
    await renderProvider()

    await startButton().click()

    await expect
      .element(
        page.getByText(
          "12 files imported, 140 attachments downloaded. 1 attachment couldn't be downloaded and still links to Reflect V1.",
        ),
      )
      .toBeInTheDocument()
  })
})
