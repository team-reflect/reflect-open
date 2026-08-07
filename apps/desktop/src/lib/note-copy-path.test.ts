import { beforeEach, describe, expect, it, vi } from 'vitest'

const joinPath = vi.hoisted(() => vi.fn(async (root: string, path: string) => `${root}/${path}`))
const operationDone = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: operationDone, fail: operationFail })),
)
vi.mock('@tauri-apps/api/path', () => ({ join: joinPath }))
vi.mock('@/lib/operations', () => ({ startOperation }))

const { runCopyNotePath } = await import('./note-copy-path')

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

beforeEach(() => {
  joinPath.mockReset().mockImplementation(async (root, path) => `${root}/${path}`)
  startOperation.mockClear()
  operationDone.mockClear()
  operationFail.mockClear()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('runCopyNotePath', () => {
  it('copies the OS-joined absolute path and completes the operation', async () => {
    const written: string[] = []
    stubClipboard(async (text) => {
      written.push(text)
    })
    await runCopyNotePath('/g', 'notes/a.md')
    expect(written).toEqual(['/g/notes/a.md'])
    expect(startOperation).toHaveBeenCalledWith('Note path copied')
    expect(operationDone).toHaveBeenCalled()
    expect(operationFail).not.toHaveBeenCalled()
  })

  it('fails loudly when no graph is open', async () => {
    await runCopyNotePath(null, 'notes/a.md')
    expect(startOperation).toHaveBeenCalledWith('Copying note path')
    expect(operationFail).toHaveBeenCalledWith('No graph is open')
  })

  it('reports a clipboard failure through the operation', async () => {
    stubClipboard(async () => {
      throw new Error('denied')
    })
    await runCopyNotePath('/g', 'notes/a.md')
    expect(startOperation).toHaveBeenCalledWith('Copying note path')
    expect(operationFail).toHaveBeenCalledWith('denied')
  })
})
