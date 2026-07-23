import { describe, expect, it } from 'vitest'
import { createDevFileStore } from './dev-file-store'

describe('dev file store discovery', () => {
  it('lists eligible root and nested Markdown with native policy parity', () => {
    const files = createDevFileStore({
      'README.md': '# Root',
      'Projects/Plan.md': '# Plan',
      'notes/managed.md': '# Managed',
      '.obsidian/private.md': '# Hidden',
      'Projects/.private/hidden.md': '# Hidden',
      'assets/caption.md': '# Asset metadata',
      'audio-memos/transcript.md': '# Recording metadata',
      'UPPER.MD': '# Wrong suffix',
    })

    expect(files.list().map((file) => file.path)).toEqual([
      'README.md',
      'Projects/Plan.md',
      'notes/managed.md',
    ])
  })
})
