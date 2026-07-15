import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assetBasenameCandidateKey } from './asset-reference-keys'

const mocks = vi.hoisted(() => {
  const execute = vi.fn()
  const distinct = vi.fn(() => ({ execute }))
  const select = vi.fn(() => ({ distinct }))
  const where = vi.fn(() => ({ select }))
  const selectFrom = vi.fn(() => ({ where }))
  return { execute, distinct, select, where, selectFrom }
})

vi.mock('./db', () => ({ db: { selectFrom: mocks.selectFrom } }))

import { assetReferencingNotePaths } from './asset-refs'

describe('assetReferencingNotePaths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.execute.mockResolvedValue([
      { notePath: 'Projects/public.md' },
      { notePath: 'Private/diary.md' },
    ])
  })

  it('queries exact and bare-wiki basename candidates together', async () => {
    await expect(assetReferencingNotePaths('assets/Photo.PNG')).resolves.toEqual([
      'Projects/public.md',
      'Private/diary.md',
    ])
    expect(mocks.where).toHaveBeenCalledWith('assetPath', 'in', [
      'assets/Photo.PNG',
      assetBasenameCandidateKey('Photo.PNG'),
    ])
  })

  it('does not query unsupported or non-managed paths', async () => {
    await expect(assetReferencingNotePaths('assets/readme.txt')).resolves.toEqual([])
    await expect(assetReferencingNotePaths('Media/photo.png')).resolves.toEqual([])
    expect(mocks.selectFrom).not.toHaveBeenCalled()
  })
})
