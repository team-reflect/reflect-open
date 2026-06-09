import { createEditor } from '@prosekit/core'
import { defineEditorExtension, docToMarkdown, markdownToDoc, type TypedEditor } from '@meowdown/core'
import { describe, expect, it } from 'vitest'

/**
 * Spike gate (Plan 01 step 8): does markdown — and specifically `[[wiki links]]`,
 * which meowdown has no dedicated support for — survive a markdownToDoc →
 * docToMarkdown round-trip without loss? meowdown keeps inline syntax as literal
 * text, so the expectation is yes.
 */
function roundtrip(markdown: string): string {
  const editor: TypedEditor = createEditor({ extension: defineEditorExtension() })
  return docToMarkdown(markdownToDoc(editor, markdown))
}

describe('meowdown markdown round-trip', () => {
  const cases = [
    '# Heading',
    'A paragraph with [[Wiki Link]] inside.',
    '[[Note|alias]]',
    'Link to [[2026-06-09]] daily note.',
    '**bold** and _em_ and `code`',
    '> a quote',
  ]

  for (const markdown of cases) {
    it(`preserves ${JSON.stringify(markdown)}`, () => {
      // docToMarkdown appends a single trailing newline (standard block-level
      // markdown serialization); content must otherwise be byte-identical.
      expect(roundtrip(markdown).replace(/\n$/, '')).toBe(markdown)
    })
  }

  it('appends exactly one trailing newline', () => {
    expect(roundtrip('# Heading')).toBe('# Heading\n')
  })

  // KNOWN NORMALIZATION (Plan 05 follow-up): docToMarkdown emits "loose" lists,
  // inserting a blank line between items. Not content loss, but it would create
  // spurious sync diffs (Plan 12) against tight-list input, so the editor needs
  // a tight-list serializer option or a normalize-on-import step before relying
  // on byte-stable round-trips.
  it('serializes lists as loose (documents the normalization)', () => {
    expect(roundtrip('- item one\n- item two')).toBe('- item one\n\n- item two\n')
  })
})
