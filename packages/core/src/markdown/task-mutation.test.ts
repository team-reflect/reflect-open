import { describe, expect, it } from 'vitest'
import { parseMarkdownAst } from '@meowdown/markdown'
import { editTaskDocument } from './task-mutation.ts'
import { inlineMarkdownToDisplayText } from './plain-text.ts'

describe('AST task mutations', () => {
  it('edits the full first paragraph and preserves details', () => {
    const source =
      '---\nid: keep\n---\n\n+ [ ] old\n  second line\n\n  > quote\n\n  ## heading\n\n  + [ ] nested\n'
    const result = editTaskDocument(source, { at: [0], text: '**new**\nline', checked: true })
    expect(result.source).toContain('---\nid: keep\n---\n\n')
    expect(result.source).toContain('+ [x] **new**\n  line')
    expect(result.source).toContain('> quote')
    expect(result.source).toContain('## heading')
    expect(result.tasks).toHaveLength(2)
  })
  it('promotes details when deleting a parent and maps the moved paths', () => {
    const result = editTaskDocument('+ [ ] parent\n  + [ ] child\n+ [ ] sibling\n', {
      at: [0],
      remove: true,
    })
    expect(result.source).toBe('+ [ ] child\n+ [ ] sibling\n')
    expect([...result.paths]).toEqual([
      ['[0,1]', [0]],
      ['[1]', [1]],
    ])
  })
  it('creates and continues empty tasks', () => {
    const initial = editTaskDocument('', { after: null, create: { text: '' } })
    expect(initial.createdPath).toEqual([0])
    const named = editTaskDocument(initial.source, { at: [0], text: 'first', checked: false })
    const next = editTaskDocument(named.source, { after: [0], create: { text: '' } })
    expect(next.createdPath).toEqual([1])
    expect(next.tasks.map((task) => task.text)).toEqual(['first', ''])
  })
  it('converts a task to a collapsed bullet, preserving descendants', () => {
    const result = editTaskDocument('+ [ ] parent\n  + [ ] child\n', {
      at: [0],
      text: 'parent',
      checked: false,
      toBullet: true,
    })
    expect(result.source).toBe('+ parent\n  + [ ] child\n')
    expect(result.tasks).toHaveLength(1)
  })
  it('keeps a no-op byte-identical and refuses a missing node', () => {
    const source = '+   [ ] same\r\n'
    expect(editTaskDocument(source, { at: [0], text: 'same', checked: false }).source).toBe(source)
    expect(() => editTaskDocument(source, { at: [99], remove: true })).toThrow()
    expect(parseMarkdownAst(source).children).toHaveLength(1)
  })
})

it('creates a checked task in one step', () => {
  const result = editTaskDocument('+ [ ] first\n', {
    after: null,
    create: { text: 'done', checked: true },
  })
  expect(result.source).toBe('+ [ ] first\n+ [x] done\n')
  expect(result.createdPath).toEqual([1])
})

it.each(['[ ] inner', '# heading', '> quote', '1. item', '+ item'])(
  'keeps %s literal when converting to a bullet',
  (value) => {
    const result = editTaskDocument('+ [ ] ' + value + '\n', {
      at: [0],
      text: value,
      checked: false,
      toBullet: true,
    })
    const item = parseMarkdownAst(result.source).children[0]
    expect(item).toMatchObject({ type: 'listItem', kind: 'bullet' })
    if (item?.type !== 'listItem' || item.children[0]?.type !== 'paragraph')
      throw new Error('Expected a paragraph')
    expect(inlineMarkdownToDisplayText(item.children[0].value)).toBe(value)
    expect(result.tasks).toEqual([])
  },
)

it.each(['+ [ ] b', '# heading', '> quote', '1. item', '---'])(
  'keeps a continuation %s inside the edited paragraph',
  (line) => {
    const result = editTaskDocument('+ [ ] old\n', { at: [0], text: 'a\n' + line, checked: false })
    expect(result.tasks).toHaveLength(1)
    expect(parseMarkdownAst(result.source).children).toHaveLength(1)
    expect(result.tasks[0]?.text).toContain('\n')
  },
)

it('rejects blank lines that cannot be represented in one paragraph before saving', () => {
  expect(() =>
    editTaskDocument('+ [ ] old\n', { at: [0], text: 'a\n\nb', checked: false }),
  ).toThrow('one task paragraph')
})

it('does not escape inline syntax when protecting another continuation line', () => {
  const result = editTaskDocument('+ [ ] old\n', {
    at: [0],
    text: '<https://example.com>\n**bold**\n+ item',
    checked: false,
  })
  expect(result.tasks[0]?.text).toBe('<https://example.com>\n**bold**\n\\+ item')
})

it('maps duplicate text by structural address and excludes quoted tasks', () => {
  const result = editTaskDocument('> + [ ] same\n\n+ [ ] same\n+ [ ] same\n', {
    at: [1],
    text: 'same',
    checked: true,
  })
  expect([...result.paths]).toEqual([
    ['[0,0]', [0, 0]],
    ['[1]', [1]],
    ['[2]', [2]],
  ])
  expect(result.tasks.map(({ astPath, checked }) => ({ astPath, checked }))).toEqual([
    { astPath: [0, 0], checked: false },
    { astPath: [1], checked: true },
    { astPath: [2], checked: false },
  ])
})
