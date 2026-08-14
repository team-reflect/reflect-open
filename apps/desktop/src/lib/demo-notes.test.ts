import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMO_NOTES_SEEDED_META_KEY, seedDemoNotes } from './demo-notes'

const getIndexMeta = vi.hoisted(() => vi.fn())
const setIndexMeta = vi.hoisted(() => vi.fn())
const writeNote = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  getIndexMeta,
  setIndexMeta,
  writeNote,
}))

beforeEach(() => {
  getIndexMeta.mockReset()
  setIndexMeta.mockReset().mockResolvedValue(undefined)
  writeNote.mockReset().mockResolvedValue(undefined)
})

describe('seedDemoNotes', () => {
  it('writes the demo notes once and stamps the marker', async () => {
    getIndexMeta.mockResolvedValue(null)

    await expect(seedDemoNotes({ fileGeneration: 7, indexGeneration: 3 })).resolves.toBe(true)

    expect(writeNote).toHaveBeenCalledTimes(3)
    for (const call of writeNote.mock.calls) {
      const [path, source, generation] = call as [string, string, number]
      expect(path).toContain('demo')
      expect(source).toContain('id:')
      expect(generation).toBe(7)
    }
    expect(setIndexMeta).toHaveBeenCalledWith(DEMO_NOTES_SEEDED_META_KEY, 'true', 3)
  })

  it('is a no-op when the marker is already set', async () => {
    getIndexMeta.mockResolvedValue('true')

    await expect(seedDemoNotes({ fileGeneration: 7, indexGeneration: 3 })).resolves.toBe(false)

    expect(writeNote).not.toHaveBeenCalled()
    expect(setIndexMeta).not.toHaveBeenCalled()
  })
})
