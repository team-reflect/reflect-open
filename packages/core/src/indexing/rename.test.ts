import { describe, expect, it } from 'vitest'
import { resolved, unresolved } from '../markdown'
import { nextAliases, rewriteLinksForTitleChange, type RenameIo } from './rename'

function fakeIo(files: Record<string, string>, options?: { resolveTo?: string }) {
  const writes: Record<string, string> = {}
  const io: RenameIo = {
    sources: async () => Object.keys(files).sort(),
    read: async (path) => {
      const content = files[path]
      if (content === undefined) {
        throw new Error(`unreadable: ${path}`)
      }
      return content
    },
    write: async (path, content) => {
      writes[path] = content
    },
    resolve: async () =>
      options?.resolveTo !== undefined ? resolved(options.resolveTo) : unresolved('x'),
  }
  return { io, writes }
}

describe('rewriteLinksForTitleChange', () => {
  it('rewrites [[from]] links across sources, preserving aliases', async () => {
    const { io, writes } = fakeIo({
      'notes/a.md': 'See [[Old Title]] for context.\n',
      'notes/b.md': 'Alias form: [[old title|the doc]].\n',
    })
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result).toEqual({ rewritten: ['notes/a.md', 'notes/b.md'], failed: [], collision: false })
    expect(writes['notes/a.md']).toBe('See [[New Title]] for context.\n')
    expect(writes['notes/b.md']).toBe('Alias form: [[New Title|the doc]].\n')
  })

  it('skips the renamed note itself and sources without a rewritable link', async () => {
    const { io, writes } = fakeIo({
      'notes/target.md': '# New Title\n[[Old Title]] self-reference\n',
      'notes/c.md': 'mentions Old Title in prose only\n',
    })
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result.rewritten).toEqual([])
    expect(writes).toEqual({})
  })

  it('never rewrites link-shaped text inside code contexts', async () => {
    const { io, writes } = fakeIo({
      'notes/code.md':
        'Real: [[Old]]\n\n```\n[[Old]] in a fence\n```\n\nAnd `[[Old]] inline`.\n',
    })
    await rewriteLinksForTitleChange({ path: 'notes/t.md', from: 'Old', to: 'New', io })
    expect(writes['notes/code.md']).toBe(
      'Real: [[New]]\n\n```\n[[Old]] in a fence\n```\n\nAnd `[[Old]] inline`.\n',
    )
  })

  it('leaves links alone when the old title belongs to a different note now', async () => {
    const { io, writes } = fakeIo(
      { 'notes/a.md': '[[Old Title]]\n' },
      { resolveTo: 'notes/other-owner.md' },
    )
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result.collision).toBe(true)
    expect(writes).toEqual({})
  })

  it('a stale index resolving to the renamed note itself is not a collision', async () => {
    const { io, writes } = fakeIo(
      { 'notes/a.md': '[[Old Title]]\n' },
      { resolveTo: 'notes/target.md' },
    )
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old Title',
      to: 'New Title',
      io,
    })
    expect(result.collision).toBe(false)
    expect(writes['notes/a.md']).toBe('[[New Title]]\n')
  })

  it('continues past a failing source and reports it', async () => {
    const files: Record<string, string> = { 'notes/ok.md': '[[Old]] here\n' }
    const { io, writes } = fakeIo(files)
    const sources = ['notes/gone.md', 'notes/ok.md'] // gone.md read throws
    io.sources = async () => sources
    const progress: Array<[number, number]> = []
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old',
      to: 'New',
      io,
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(result.failed).toEqual(['notes/gone.md'])
    expect(result.rewritten).toEqual(['notes/ok.md'])
    expect(writes['notes/ok.md']).toBe('[[New]] here\n')
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('rewrites links using the visible targets of rich titles', async () => {
    const { io, writes } = fakeIo({
      'notes/source.md': 'Discuss [[Meeting with Ada]] tomorrow.\n',
    })
    io.sources = async (targetKey) => {
      expect(targetKey).toBe('meeting with ada')
      return ['notes/source.md']
    }
    io.resolve = async (target) => {
      expect(target).toBe('Meeting with Ada')
      return unresolved(target)
    }

    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Meeting with [[Ada Lovelace|Ada]]',
      to: 'Meeting with [[Grace Hopper|Grace]]',
      io,
    })

    expect(result.rewritten).toEqual(['notes/source.md'])
    expect(writes['notes/source.md']).toBe('Discuss [[Meeting with Grace]] tomorrow.\n')
  })

  it('preserves repeated whitespace in ordinary title rewrites', async () => {
    const { io, writes } = fakeIo({ 'notes/source.md': '[[Old  Title]]\n' })
    io.sources = async (targetKey) => {
      expect(targetKey).toBe('old  title')
      return ['notes/source.md']
    }

    await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old  Title',
      to: 'New  Title',
      io,
    })

    expect(writes['notes/source.md']).toBe('[[New  Title]]\n')
  })
})

describe('rewriteLinksForTitleChange write failures', () => {
  it('continues past a write failure and reports it', async () => {
    const { io, writes } = fakeIo({
      'notes/fail.md': '[[Old]]\n',
      'notes/ok.md': '[[Old]]\n',
    })
    const write = io.write
    io.write = async (path, content) => {
      if (path === 'notes/fail.md') {
        throw new Error('write failed')
      }
      await write(path, content)
    }
    const result = await rewriteLinksForTitleChange({
      path: 'notes/target.md',
      from: 'Old',
      to: 'New',
      io,
    })
    expect(result.failed).toEqual(['notes/fail.md'])
    expect(result.rewritten).toEqual(['notes/ok.md'])
    expect(writes['notes/ok.md']).toBe('[[New]]\n')
    expect(writes['notes/fail.md']).toBeUndefined()
  })
})

describe('nextAliases', () => {
  it('adds the old title and prunes the previous auto-alias', () => {
    expect(
      nextAliases(['First', 'keeper'], {
        from: 'Second',
        to: 'Third',
        previousAutoAlias: 'First',
      }),
    ).toEqual(['keeper', 'Second'])
  })

  it('does not duplicate an existing alias (case-insensitive)', () => {
    expect(
      nextAliases(['old title'], { from: 'Old Title', to: 'New', previousAutoAlias: null }),
    ).toBeNull()
  })

  it('returns null when nothing changes', () => {
    expect(
      nextAliases([], { from: 'Same', to: 'same', previousAutoAlias: null }),
    ).toBeNull()
  })

  it('adds the first alias to an empty list', () => {
    expect(nextAliases([], { from: 'Old', to: 'New', previousAutoAlias: null })).toEqual(['Old'])
  })

  it('preserves the raw rich old title for non-wiki resolution', () => {
    expect(
      nextAliases([], {
        from: 'Meeting with [[Ada Lovelace|Ada]]',
        to: 'Meeting with [[Grace Hopper|Grace]]',
        previousAutoAlias: null,
      }),
    ).toEqual(['Meeting with [[Ada Lovelace|Ada]]'])
  })
})
