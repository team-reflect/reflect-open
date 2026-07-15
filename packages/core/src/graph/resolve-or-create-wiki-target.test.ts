import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoteIfAbsent } from './commands'
import { resolveOrCreateWikiTarget } from './create-note'
import { resolveExistingWikiTarget } from './resolve-existing-wiki-target'

vi.mock('./commands', () => ({ createNoteIfAbsent: vi.fn() }))
vi.mock('./resolve-existing-wiki-target', () => ({
  resolveExistingWikiTarget: vi.fn(),
}))

const createNoteIfAbsentMock = vi.mocked(createNoteIfAbsent)
const resolveExistingWikiTargetMock = vi.mocked(resolveExistingWikiTarget)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveOrCreateWikiTarget', () => {
  it('resolves a same-note heading without attempting to create a title', async () => {
    resolveExistingWikiTargetMock.mockResolvedValue({
      kind: 'resolved',
      path: 'Projects/Plan.md',
      fragment: 'Roadmap',
    })

    await expect(
      resolveOrCreateWikiTarget('#Roadmap', 'Projects/Plan.md', 7),
    ).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
      fragment: 'Roadmap',
    })
    expect(resolveExistingWikiTargetMock).toHaveBeenCalledWith(
      '#Roadmap',
      7,
      'Projects/Plan.md',
    )
    expect(createNoteIfAbsentMock).not.toHaveBeenCalled()
  })

  it('atomically creates the exact safe path named by a missing path-qualified link', async () => {
    resolveExistingWikiTargetMock.mockResolvedValue({ kind: 'missing' })
    createNoteIfAbsentMock.mockResolvedValue({ kind: 'created', modifiedMs: 42 })

    await expect(
      resolveOrCreateWikiTarget('Projects/Plan', 'Inbox.md', 7),
    ).resolves.toEqual({ kind: 'created', path: 'Projects/Plan.md' })
    expect(createNoteIfAbsentMock).toHaveBeenCalledWith(
      'Projects/Plan.md',
      '# Plan\n',
      7,
    )
  })

  it.each(['.NET', 'C:', 'mailto:foo', 'Project:Alpha', 'https:'])(
    'creates the bare title %s only through a safe notes slug',
    async (title) => {
      resolveExistingWikiTargetMock.mockResolvedValue({ kind: 'missing' })
      createNoteIfAbsentMock.mockResolvedValue({ kind: 'created', modifiedMs: 42 })

      const outcome = await resolveOrCreateWikiTarget(title, 'Inbox.md', 7)

      expect(outcome.kind).toBe('created')
      const createdPath = createNoteIfAbsentMock.mock.calls[0]?.[0]
      expect(createdPath).toMatch(/^notes\/[a-z0-9-]+\.md$/)
      expect(createdPath).not.toContain(':')
    },
  )

  it('returns invalid for a traversal target', async () => {
    resolveExistingWikiTargetMock.mockResolvedValue({ kind: 'invalid' })

    await expect(
      resolveOrCreateWikiTarget('../Secret', 'Projects/Plan.md', 7),
    ).resolves.toEqual({ kind: 'invalid' })
    expect(createNoteIfAbsentMock).not.toHaveBeenCalled()
  })

  it.each([
    '/absolute/secret',
    '//server/share',
    '\\\\server\\share',
    'C:/Users/secret',
    'file:///private/secret',
    'https://example.com/secret',
    '.obsidian/secret',
    'Projects/%00secret',
  ])('never creates an unsafe authored target: %s', async (target) => {
    resolveExistingWikiTargetMock.mockResolvedValue({ kind: 'missing' })

    await expect(
      resolveOrCreateWikiTarget(target, 'Projects/Plan.md', 7),
    ).resolves.toEqual({ kind: 'invalid' })
    expect(createNoteIfAbsentMock).not.toHaveBeenCalled()
  })
})
