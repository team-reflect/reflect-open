import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANNOTATION_WRITE_DEBOUNCE_MS, usePdfAnnotations } from './annotations-store'

const ipc = vi.hoisted(() => ({
  readAnnotations: vi.fn(),
  writeAnnotations: vi.fn(),
}))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readAnnotations: ipc.readAnnotations,
  writeAnnotations: ipc.writeAnnotations,
}))

function Harness({ path, generation }: { path: string; generation: number | null }) {
  const { annotations, addAnnotation } = usePdfAnnotations(path, generation)
  return (
    <div>
      <span data-testid="count">{annotations.length}</span>
      <button
        type="button"
        onClick={() =>
          addAnnotation({
            pageIndex: 0,
            type: 'border',
            rects: [[0, 0, 0.1, 0.1]],
            color: '#FFD400',
            text: '',
          })
        }
      >
        add
      </button>
    </div>
  )
}

async function renderStore(path: string) {
  const view = await render(<Harness path={path} generation={1} />)
  await vi.waitFor(() => expect(ipc.readAnnotations).toHaveBeenCalled())
  return view
}

beforeEach(() => {
  ipc.readAnnotations.mockReset().mockResolvedValue('')
  ipc.writeAnnotations.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('usePdfAnnotations persistence', () => {
  it('serializes writes so a slow earlier one never overwrites a later one', async () => {
    let releaseFirst!: () => void
    ipc.writeAnnotations.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
    )
    ipc.writeAnnotations.mockResolvedValue(undefined)

    await renderStore('assets/paper.pdf')
    await page.getByRole('button', { name: 'add' }).click()
    await vi.waitFor(() => expect(ipc.writeAnnotations).toHaveBeenCalledTimes(1))

    await page.getByRole('button', { name: 'add' }).click()
    // The second write is chained behind the first (dispatch order is
    // serialized), so it is not even sent while the first is in flight.
    await new Promise((resolve) => setTimeout(resolve, ANNOTATION_WRITE_DEBOUNCE_MS + 100))
    expect(ipc.writeAnnotations).toHaveBeenCalledTimes(1)

    releaseFirst()
    await vi.waitFor(() => expect(ipc.writeAnnotations).toHaveBeenCalledTimes(2))
    // The chain kept dispatch order: the first write carries one annotation,
    // the second two.
    const first = JSON.parse(ipc.writeAnnotations.mock.calls[0]?.[1] as string) as {
      annotations: unknown[]
    }
    const second = JSON.parse(ipc.writeAnnotations.mock.calls[1]?.[1] as string) as {
      annotations: unknown[]
    }
    expect(first.annotations).toHaveLength(1)
    expect(second.annotations).toHaveLength(2)
  })

  it('flushes the scheduled snapshot, not a reset state, on a key change', async () => {
    ipc.writeAnnotations.mockResolvedValue(undefined)
    const view = await renderStore('assets/paper.pdf')
    await page.getByRole('button', { name: 'add' }).click()

    // Switch PDFs before the debounce fires: the pending write must flush the
    // snapshot taken at schedule time (one annotation), never an empty reset.
    await view.rerender(<Harness path="assets/other.pdf" generation={1} />)
    await vi.waitFor(() => expect(ipc.writeAnnotations).toHaveBeenCalledTimes(1))
    const flushed = JSON.parse(ipc.writeAnnotations.mock.calls[0]?.[1] as string) as {
      path: string
      annotations: unknown[]
    }
    expect(flushed.path).toBe('assets/paper.pdf')
    expect(flushed.annotations).toHaveLength(1)
  })
})
