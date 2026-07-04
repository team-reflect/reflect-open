import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.hoisted(() => vi.fn<() => Promise<string | null>>())
const importReflectV1Zip = vi.hoisted(() =>
  vi.fn<() => Promise<{ importedFiles: number; skippedFiles: number; changedPaths: string[] }>>(),
)
const markReflectV1ImportOwnWrites = vi.hoisted(() => vi.fn())
const graphState = vi.hoisted(() => ({
  graph: { root: '/graphs/notes', name: 'Notes', generation: 42 } as {
    root: string
    name: string
    generation: number
  } | null,
  refreshIndex: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))
vi.mock('@reflect/core', () => ({
  importReflectV1Zip,
  markReflectV1ImportOwnWrites,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: graphState.graph, refreshIndex: graphState.refreshIndex }),
}))

const { ImportSection } = await import('./import-section')

beforeEach(() => {
  open.mockResolvedValue('/Users/alex/Downloads/reflect-v1.zip')
  importReflectV1Zip.mockResolvedValue({
    importedFiles: 2,
    skippedFiles: 1,
    changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
  })
  graphState.graph = { root: '/graphs/notes', name: 'Notes', generation: 42 }
  graphState.refreshIndex.mockClear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function importButton(): HTMLButtonElement {
  const element = screen.getByRole('button', { name: /import zip/i })
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error('expected button')
  }
  return element
}

describe('ImportSection', () => {
  it('imports the selected Reflect V1 zip into the open graph', async () => {
    render(<ImportSection />)

    fireEvent.click(importButton())

    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        multiple: false,
        directory: false,
        title: 'Import Reflect V1 export',
        filters: [{ name: 'Zip archives', extensions: ['zip'] }],
      }),
    )
    await waitFor(() =>
      expect(importReflectV1Zip).toHaveBeenCalledWith(
        '/Users/alex/Downloads/reflect-v1.zip',
        42,
      ),
    )
    expect(markReflectV1ImportOwnWrites).toHaveBeenCalledWith({
      importedFiles: 2,
      skippedFiles: 1,
      changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    })
    expect(graphState.refreshIndex).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('status')).textContent).toBe(
      '2 files imported, 1 already present.',
    )
  })

  it('does nothing when the picker is cancelled', async () => {
    open.mockResolvedValueOnce(null)
    render(<ImportSection />)

    fireEvent.click(importButton())

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(importReflectV1Zip).not.toHaveBeenCalled()
    expect(graphState.refreshIndex).not.toHaveBeenCalled()
  })

  it('surfaces import failures inline', async () => {
    importReflectV1Zip.mockRejectedValueOnce(new Error('import would overwrite notes/a.md'))
    render(<ImportSection />)

    fireEvent.click(importButton())

    expect((await screen.findByRole('alert')).textContent).toBe(
      'import would overwrite notes/a.md',
    )
  })

  it('does not show success after the user switches graphs mid-import', async () => {
    let finishImport: (summary: {
      importedFiles: number
      skippedFiles: number
      changedPaths: string[]
    }) => void = () => {}
    importReflectV1Zip.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve
        }),
    )
    const view = render(<ImportSection />)

    fireEvent.click(importButton())
    await waitFor(() => expect(importReflectV1Zip).toHaveBeenCalledTimes(1))

    graphState.graph = { root: '/graphs/other', name: 'Other', generation: 43 }
    view.rerender(<ImportSection />)
    finishImport({ importedFiles: 7, skippedFiles: 0, changedPaths: ['notes/a.md'] })

    await screen.findByRole('button', { name: /import zip/i })
    expect(markReflectV1ImportOwnWrites).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(graphState.refreshIndex).not.toHaveBeenCalled()
  })

  it('is disabled until a graph is open', () => {
    graphState.graph = null
    render(<ImportSection />)

    expect(importButton().hasAttribute('disabled')).toBe(true)
  })
})
