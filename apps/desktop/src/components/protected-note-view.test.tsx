import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import { ProtectedNoteView } from './protected-note-view'

const CONTENT = `---
title: Setext
---

Unsupported Setext Heading
==========================

body text
`

describe('ProtectedNoteView', () => {
  it('announces the read-only notice as an alert', async () => {
    const view = await render(<ProtectedNoteView content={CONTENT} />)
    const alert = view.getByRole('alert').element()
    expect(alert.textContent).toContain(
      'This note contains markdown the editor can’t yet reproduce faithfully',
    )
    expect(alert.textContent).toContain('open read-only to protect your file')
    await view.unmount()
  })

  it('shows the full file content verbatim, frontmatter included', async () => {
    const view = await render(<ProtectedNoteView content={CONTENT} />)
    const verbatim = view.container.querySelector('pre')
    expect(verbatim?.textContent).toBe(CONTENT)
    await view.unmount()
  })
})
