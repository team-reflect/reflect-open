import { describe, expect, it } from 'vitest'
import { groupBacklinksBySource } from './group-backlinks'

describe('groupBacklinksBySource', () => {
  it('groups rows by source note, preserving order and per-link keys', () => {
    const groups = groupBacklinksBySource([
      { sourcePath: 'notes/a.md', sourceTitle: 'A', snippet: 'first [[t]]', posFrom: 4, tasks: [] },
      { sourcePath: 'notes/a.md', sourceTitle: 'A', snippet: 'second [[t]]', posFrom: 40, tasks: [] },
      { sourcePath: 'notes/b.md', sourceTitle: 'B', snippet: 'only [[t]]', posFrom: 9, tasks: [] },
    ])

    expect(groups).toEqual([
      {
        path: 'notes/a.md',
        title: 'A',
        snippets: [
          { key: 'notes/a.md:4', text: 'first [[t]]', tasks: [] },
          { key: 'notes/a.md:40', text: 'second [[t]]', tasks: [] },
        ],
      },
      {
        path: 'notes/b.md',
        title: 'B',
        snippets: [{ key: 'notes/b.md:9', text: 'only [[t]]', tasks: [] }],
      },
    ])
  })

  it('drops empty snippets but keeps the source group', () => {
    const groups = groupBacklinksBySource([
      { sourcePath: 'notes/gone.md', sourceTitle: 'Gone', snippet: '', posFrom: 0, tasks: [] },
    ])
    expect(groups).toEqual([{ path: 'notes/gone.md', title: 'Gone', snippets: [] }])
  })
})
