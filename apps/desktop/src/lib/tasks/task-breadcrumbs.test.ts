import { describe, expect, it } from 'vitest'
import { visibleTaskBreadcrumbs } from './task-breadcrumbs'

describe('visibleTaskBreadcrumbs', () => {
  it('trims empty breadcrumb entries', () => {
    expect(visibleTaskBreadcrumbs(['', ' Project ', '  '])).toEqual(['Project'])
  })

  it('hides common single task headings', () => {
    expect(visibleTaskBreadcrumbs(['Tasks'])).toEqual([])
    expect(visibleTaskBreadcrumbs(['to-do'])).toEqual([])
  })

  it('keeps multi-part breadcrumbs even when one part is common', () => {
    expect(visibleTaskBreadcrumbs(['Tasks', 'Project'])).toEqual(['Tasks', 'Project'])
  })
})
