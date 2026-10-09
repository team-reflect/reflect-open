import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { makeOpenTask } from '@/lib/tasks/open-task-fixture.ts'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { TaskText } from './task-text.tsx'

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

describe('TaskText', () => {
  it('renders a task marker at the start of the text as text, not a checkbox', async () => {
    const view = await render(<TaskText task={makeOpenTask({ markdown: '+ [ ] task' })} />)
    expect(view.container.textContent).toContain('+ [ ] task')
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull()
    await view.unmount()
  })

  it('would render that marker as a checkbox without single-paragraph mode', async () => {
    const view = await render(<MarkdownPreview content="+ [ ] task" />)
    expect(view.container.querySelector('input[type="checkbox"]')).not.toBeNull()
    await view.unmount()
  })
})
