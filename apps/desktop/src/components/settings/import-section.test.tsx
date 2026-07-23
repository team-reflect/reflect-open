import { render } from 'vitest-browser-react'
import { page, type Locator } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V1ImportState } from '@/providers/v1-import-provider'

const open = vi.hoisted(() => vi.fn<() => Promise<string | null>>())
const startImport = vi.hoisted(() => vi.fn())
const importState = vi.hoisted((): { state: V1ImportState } => ({
  state: { phase: 'idle' },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))
vi.mock('@/providers/v1-import-provider', () => ({
  useV1Import: () => ({
    state: importState.state,
    startImport,
    cancelImport: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

const { ImportSection } = await import('./import-section')

beforeEach(() => {
  open.mockResolvedValue('/Users/alex/Downloads/reflect-v1.zip')
  importState.state = { phase: 'idle' }
})

afterEach(() => {
  vi.clearAllMocks()
})

function importButton(): Locator {
  return page.getByRole('button', { name: /import/i })
}

describe('ImportSection', () => {
  it('hands the picked Reflect V1 zip to the import controller', async () => {
    await render(<ImportSection />)

    await importButton().click()

    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        multiple: false,
        directory: false,
        title: 'Import Reflect V1 export',
        filters: [{ name: 'Zip archives', extensions: ['zip'] }],
      }),
    )
    await vi.waitFor(() =>
      expect(startImport).toHaveBeenCalledWith('/Users/alex/Downloads/reflect-v1.zip'),
    )
  })

  it('does nothing when the picker is cancelled', async () => {
    open.mockResolvedValueOnce(null)
    await render(<ImportSection />)

    await importButton().click()

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(startImport).not.toHaveBeenCalled()
  })

  it('is disabled while an import runs', async () => {
    importState.state = { phase: 'running', progress: null, cancelling: false }
    await render(<ImportSection />)

    await expect.element(importButton()).toBeDisabled()
    expect(importButton().element().textContent).toContain('Importing')
  })
})
