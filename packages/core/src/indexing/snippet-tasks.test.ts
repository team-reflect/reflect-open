import { describe, expect, it } from 'vitest'
import { extractSnippetTasks } from './snippet-tasks.ts'

describe('snippet checkboxes', () => {
  it('enumerates round and square checkboxes in rendering order without note addresses', () => {
    expect(extractSnippetTasks('+ [ ] parent\n  - [x] square\n  + [ ] child')).toEqual([
      { checked: false, round: true, text: 'parent' },
      { checked: true, round: false, text: 'square' },
      { checked: false, round: true, text: 'child' },
    ])
  })
  it('does not count ordered markers or fenced code', () => {
    expect(extractSnippetTasks('1. [ ] ordered\n\n```\n+ [ ] code\n```')).toEqual([])
  })
})

it('maps a dedented nested checkbox back to the complete note AST', () => {
  const content = '# Note\n\n+ parent\n  + [ ] child\n'
  const tasks = extractSnippetTasks('+ [ ] child', {
    content,
    notePath: 'notes/a.md',
    lineOrigins: [content.indexOf('+ [ ] child')],
  })
  expect(tasks[0]?.address).toEqual({ notePath: 'notes/a.md', astPath: [1, 1] })
})
