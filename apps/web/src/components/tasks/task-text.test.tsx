import { describe, expect, it } from 'vitest'
import { makeOpenTask } from '@reflect/core/testing'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { TaskText } from './task-text.tsx'

const GRAPH = { root: '/g', name: 'g', generation: 7 }

describe('TaskText', () => {
  it('renders a task marker at the start of the text as text, not a checkbox', async () => {
    const view = await renderInApp(<TaskText task={makeOpenTask({ markdown: '+ [ ] task' })} />, {
      graph: GRAPH,
    })
    expect(view.container.textContent).toContain('+ [ ] task')
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull()
    await view.unmount()
  })

  it('would render that marker as a checkbox without single-paragraph mode', async () => {
    const view = await renderInApp(<MarkdownPreview content="+ [ ] task" sourcePath={null} />, {
      graph: GRAPH,
    })
    expect(view.container.querySelector('input[type="checkbox"]')).not.toBeNull()
    await view.unmount()
  })
})
