import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { GraphImportProgress, GraphImportSummary, GraphInfo } from '@reflect/core'
import {
  createTestCoreServices,
  createTestGraphSessionService,
  createTestIpcBridgeService,
} from '@reflect/core/testing'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useV1Import, V1ImportProvider } from './v1-import-provider.tsx'

const GRAPH: GraphInfo = { root: '/graphs/notes', name: 'Notes', generation: 42 }

function summary(overrides: Partial<GraphImportSummary> = {}): GraphImportSummary {
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

function Probe(): ReactElement {
  const { state, startImport } = useV1Import()
  return (
    <button type="button" onClick={() => startImport('/tmp/reflect-v1.zip')}>
      start ({state.phase})
    </button>
  )
}

/**
 * The provider over test services with `GRAPH` open. The native import
 * answers `result`, or stays pending until `pendingImport` settles.
 */
async function renderProvider(result?: GraphImportSummary | Error) {
  const pendingImport = Promise.withResolvers<GraphImportSummary>()
  const ipc = createTestIpcBridgeService({
    commands: {
      graph_import_reflect_v1_zip: () => {
        if (result instanceof Error) {
          throw result
        }
        return result ?? pendingImport.promise
      },
      graph_import_cancel: () => null,
    },
  })
  const session = createTestGraphSessionService({ state: { status: 'ready', graph: GRAPH } })
  const refreshIndex = vi.spyOn(session, 'refreshIndex').mockImplementation(() => {})
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    ipc,
    graphSession: session,
  })
  const view = await renderInApp(
    <V1ImportProvider>
      <Probe />
    </V1ImportProvider>,
    { core, servicesOnly: true },
  )
  return {
    view,
    ipc,
    session,
    refreshIndex,
    pendingImport,
    ownWrites: () => core.fileChanges.ownWrites(),
    commands: () => ipc.calls().map((call) => call.command),
    emitProgress: (progress: GraphImportProgress) => ipc.emit('import:progress', progress),
  }
}

function startButton() {
  return page.getByRole('button', { name: /start/ })
}

describe('V1ImportProvider', () => {
  it('runs the import and reports the outcome in the dialog', async () => {
    const context = await renderProvider()

    await startButton().click()

    await expect.element(page.getByText('Importing from Reflect V1')).toBeInTheDocument()
    await expect.element(page.getByText('Reading the export…')).toBeInTheDocument()
    expect(context.ipc.calls()).toEqual([
      {
        command: 'graph_import_reflect_v1_zip',
        args: { path: '/tmp/reflect-v1.zip', generation: 42 },
      },
    ])

    context.emitProgress({ stage: 'downloading', done: 3, total: 8 })
    await expect.element(page.getByText('Downloading attachments… 3 of 8')).toBeInTheDocument()

    context.emitProgress({ stage: 'writing', done: 10, total: 40 })
    await expect.element(page.getByText('Adding notes… 10 of 40')).toBeInTheDocument()

    context.pendingImport.resolve(summary({ mergedFiles: 1, renamedFiles: 1 }))
    await expect.element(page.getByText('Import complete')).toBeInTheDocument()
    await expect
      .element(
        page.getByText(
          '2 files imported, 1 daily note merged, 1 renamed to avoid a name clash, 1 already present.',
        ),
      )
      .toBeInTheDocument()
    expect(context.ownWrites()).toEqual([['notes/a.md'], ['daily/2026-07-04.md']])
    expect(context.refreshIndex).toHaveBeenCalledTimes(1)

    await page.getByRole('button', { name: 'Done' }).click()
    await expectLocatorToHaveCount(page.getByText('Import complete'), 0)
  })

  it('cannot be dismissed while the import runs', async () => {
    await renderProvider()

    await startButton().click()
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()

    expect(page.getByRole('button', { name: 'Close' }).query()).toBeNull()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByText('Importing from Reflect V1')).toBeInTheDocument()
  })

  it('cancels the running import and settles back to idle', async () => {
    const context = await renderProvider()

    await startButton().click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    expect(context.commands()).toEqual(['graph_import_reflect_v1_zip', 'graph_import_cancel'])
    await expect.element(page.getByRole('button', { name: 'Cancelling…' })).toBeInTheDocument()

    context.pendingImport.reject(new Error('import cancelled'))
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
    expect(page.getByText('Import failed').query()).toBeNull()
    expect(context.ownWrites()).toEqual([])
  })

  it('hides Cancel once writing starts (nothing can be aborted safely)', async () => {
    const context = await renderProvider()

    await startButton().click()
    await expect
      .element(page.getByRole('button', { name: 'Cancel', exact: true }))
      .toBeInTheDocument()

    context.emitProgress({ stage: 'writing', done: 1, total: 4 })
    await expectLocatorToHaveCount(page.getByRole('button', { name: 'Cancel' }), 0)
  })

  it('surfaces failures with the native message', async () => {
    const context = await renderProvider(new Error('could not read the zip'))

    await startButton().click()

    await expect.element(page.getByText('Import failed')).toBeInTheDocument()
    await expect.element(page.getByText('could not read the zip')).toBeInTheDocument()
    expect(context.refreshIndex).not.toHaveBeenCalled()

    await page.getByRole('button', { name: 'Close' }).click()
    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
  })

  it('drops the result when the graph switched mid-import', async () => {
    const context = await renderProvider()

    await startButton().click()
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()

    context.session.setState({ graph: { root: '/graphs/other', name: 'Other', generation: 43 } })
    context.pendingImport.resolve(summary())

    await expectLocatorToHaveCount(page.getByRole('dialog'), 0)
    expect(context.ownWrites()).toEqual([])
    expect(context.refreshIndex).not.toHaveBeenCalled()
  })

  it('cancels and drops the result when the workspace unmounts mid-import', async () => {
    const context = await renderProvider()

    await startButton().click()
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()

    await context.view.unmount()
    expect(context.commands()).toEqual(['graph_import_reflect_v1_zip', 'graph_import_cancel'])

    context.pendingImport.resolve(summary())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(context.ownWrites()).toEqual([])
    expect(context.refreshIndex).not.toHaveBeenCalled()
  })

  it('summarizes failed attachment downloads', async () => {
    await renderProvider(
      summary({
        importedFiles: 12,
        skippedFiles: 0,
        downloadedAssets: 140,
        failedAssetDownloads: 1,
        changedPaths: ['notes/a.md'],
      }),
    )

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
