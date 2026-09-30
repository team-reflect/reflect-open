import { describe, expect, it } from 'vitest'
import { inlineMarkdownToDisplayText } from './plain-text.ts'
import { parseNote } from './extract.ts'
import { decodeTaskPath, encodeTaskPath, compareTaskPaths } from './task-path.ts'

const parse = (source: string) => parseNote({ path: 'notes/n.md', source })

describe('AST task projection', () => {
  it('addresses every child and retains only the complete first paragraph', () => {
    const note = parse(
      '---\ntitle: Test\n---\n# Heading\n\n+ **Project**\n  + [ ] **first**\n    *second* [[2026-10-01]]\n\n    detail [[2026-10-02]]\n\n    > quote\n\n    + [x] nested\n',
    )
    expect(note.tasks).toEqual([
      {
        astPath: [1, 1],
        text: '**first**\n*second* [[2026-10-01]]',
        checked: false,
        dueDate: '2026-10-01',
        breadcrumbs: ['Project'],
      },
      {
        astPath: [1, 1, 3],
        text: 'nested',
        checked: true,
        dueDate: null,
        breadcrumbs: ['Project', 'first second 2026-10-01'],
      },
    ])
  })
  it('excludes quotes, square checklists, ordered markers and code', () => {
    expect(
      parse(
        '> + [ ] quote\n\n- [ ] square\n\n1. [ ] ordered\n\n```\n+ [ ] code\n```\n\n+ [ ] real',
      ).tasks.map((task) => task.text),
    ).toEqual(['real'])
  })
  it('keeps duplicate tasks at distinct paths and normalizes line endings', () => {
    const note = parse('+ [ ] same\r\n+ [ ] same\r\n')
    expect(note.tasks.map((task) => task.astPath)).toEqual([[0], [1]])
    expect(note.tasks.map((task) => task.text)).toEqual(['same', 'same'])
  })
  it('does not use dates in code or later blocks', () => {
    expect(
      parse('+ [ ] `[[2026-10-01]]` [[2026-02-31]]\n\n  details [[2026-10-02]]').tasks[0]?.dueDate,
    ).toBeNull()
  })
  it('keeps paragraph block-opening characters as inline text', () => {
    expect(inlineMarkdownToDisplayText('# **heading-looking**')).toBe('# heading-looking')
    expect(inlineMarkdownToDisplayText('> *quote-looking*')).toBe('> quote-looking')
    expect(parse('+ [ ] ``` [[2026-10-01]]').tasks[0]?.dueDate).toBe('2026-10-01')
  })
  it('orders numeric paths and places ancestors first', () => {
    const paths = [[10], [2, 10], [2, 1], [2], [0]]
    expect(paths.sort(compareTaskPaths)).toEqual([[0], [2], [2, 1], [2, 10], [10]])
    expect(encodeTaskPath(decodeTaskPath('[2,1]'))).toBe('[2,1]')
    for (const invalid of ['[]', '[-1]', '[1.5]', '[9007199254740992]', '["2"]', 'null'])
      expect(() => decodeTaskPath(invalid)).toThrow()
  })
})
