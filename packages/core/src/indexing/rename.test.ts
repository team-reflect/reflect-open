import { describe, expect, it } from 'vitest'
import { resolved, unresolved } from '../markdown'
import {
  nextAliases,
  prepareNoteMoveRewrites,
  rewriteLinksForTitleChange,
  type RenameIo,
} from './rename'

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

describe('prepareNoteMoveRewrites', () => {
  it('rewrites path-qualified wiki and relative Markdown links without touching labels or fragments', async () => {
    const source = [
      'Wiki: [[notes/old-title#Details|the plan]].',
      'Markdown: [the plan](../notes/old-title.md#Details "keep title").',
      'Bare title stays [[Old Title]].',
      '',
    ].join('\n')
    const result = await prepareNoteMoveRewrites({
      fromPath: 'notes/old-title.md',
      toPath: 'notes/new-title.md',
      backlinks: [
        { sourcePath: 'Projects/source.md', kind: 'wiki', targetRaw: 'notes/old-title#Details' },
        {
          sourcePath: 'Projects/source.md',
          kind: 'md',
          targetRaw: '../notes/old-title.md#Details',
        },
        { sourcePath: 'Projects/source.md', kind: 'wiki', targetRaw: 'Old Title' },
      ],
      read: async () => source,
    })

    expect(result.failed).toEqual([])
    expect(result.rewrites).toEqual([
      {
        path: 'Projects/source.md',
        before: source,
        after: [
          'Wiki: [[notes/new-title#Details|the plan]].',
          'Markdown: [the plan](../notes/new-title.md#Details "keep title").',
          'Bare title stays [[Old Title]].',
          '',
        ].join('\n'),
      },
    ])
  })

  it('preserves optional extensions, root-relative hrefs, and bracketed href syntax', async () => {
    const source = '[[notes/old-title.md|Wiki]] [Root](</notes/old-title#Part>)\n'
    const result = await prepareNoteMoveRewrites({
      fromPath: 'notes/old-title.md',
      toPath: 'notes/new-title.md',
      backlinks: [
        { sourcePath: 'README.md', kind: 'wiki', targetRaw: 'notes/old-title.md' },
        { sourcePath: 'README.md', kind: 'md', targetRaw: '/notes/old-title#Part' },
      ],
      read: async () => source,
    })

    expect(result.failed).toEqual([])
    expect(result.rewrites[0]!.after).toBe(
      '[[notes/new-title.md|Wiki]] [Root](</notes/new-title#Part>)\n',
    )
  })

  it('fails closed when an indexed reference no longer exists in current bytes', async () => {
    const result = await prepareNoteMoveRewrites({
      fromPath: 'notes/old.md',
      toPath: 'notes/new.md',
      backlinks: [{ sourcePath: 'notes/source.md', kind: 'wiki', targetRaw: 'notes/old' }],
      read: async () => 'The link was edited externally.\n',
    })
    expect(result).toEqual({ rewrites: [], failed: ['notes/source.md'] })
  })

  it('ignores bare-title backlinks and never rewrites wiki embeds', async () => {
    const source = '[[Old]] ![[notes/old]]\n'
    const result = await prepareNoteMoveRewrites({
      fromPath: 'notes/old.md',
      toPath: 'notes/new.md',
      backlinks: [{ sourcePath: 'notes/source.md', kind: 'wiki', targetRaw: 'Old' }],
      read: async () => source,
    })
    expect(result).toEqual({ rewrites: [], failed: [] })
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
})
