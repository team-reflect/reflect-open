import { page, type Locator } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDialogService, type TestDialogService } from '@reflect/app/testing'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { V1ImportProvider } from '@/providers/v1-import-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { ImportSection } from './import-section.tsx'

const IMPORT_COMMAND = 'graph_import_reflect_v1_zip'

let dialog: TestDialogService

beforeEach(() => {
  dialog = createTestDialogService({ files: ['/Users/alex/Downloads/reflect-v1.zip'] })
})

/**
 * The section under the workspace's real V1 import, whose native import never finishes.
 */
async function renderSection(): Promise<TestCoreServices> {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  core.ipc.onCommand(IMPORT_COMMAND, () => new Promise<never>(() => {}))
  await renderInApp(<ImportSection />, {
    core,
    appServices: { dialog },
    graph: { generation: 4 },
    wrapper: (children) => <V1ImportProvider>{children}</V1ImportProvider>,
  })
  return core
}

function importCalls(core: TestCoreServices): Record<string, unknown>[] {
  return core.ipc
    .calls()
    .filter((call) => call.command === IMPORT_COMMAND)
    .map((call) => call.args)
}

function importButton(): Locator {
  return page.getByRole('button', { name: /import/i })
}

describe('ImportSection', () => {
  it('hands the picked Reflect V1 zip to the import controller', async () => {
    const core = await renderSection()

    await importButton().click()

    await vi.waitFor(() => {
      expect(dialog.calls()).toEqual([
        {
          kind: 'files',
          options: {
            multiple: false,
            title: 'Import Reflect V1 export',
            filters: [{ name: 'Zip archives', extensions: ['zip'] }],
          },
        },
      ])
    })
    await vi.waitFor(() => {
      expect(importCalls(core)).toEqual([
        { path: '/Users/alex/Downloads/reflect-v1.zip', generation: 4 },
      ])
    })
  })

  it('does nothing when the picker is cancelled', async () => {
    dialog.setFiles(null)
    const core = await renderSection()

    await importButton().click()

    await vi.waitFor(() => expect(dialog.calls()).toHaveLength(1))
    expect(importCalls(core)).toEqual([])
  })

  it('is disabled while an import runs', async () => {
    await renderSection()

    await importButton().click()

    // The running import shows its modal dialog, which hides the section from
    // the accessibility tree: find the button by its text.
    await expect.element(page.getByText('Importing...')).toBeDisabled()
  })
})
