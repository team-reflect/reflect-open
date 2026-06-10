import type { ReactElement } from 'react'
import type { EditorMarkdownSyntax } from '@reflect/core'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { SettingsSection } from './section'

interface MarkdownSyntaxOption {
  value: EditorMarkdownSyntax
  label: string
  description: string
}

const MARKDOWN_SYNTAX_OPTIONS: MarkdownSyntaxOption[] = [
  {
    value: 'focus',
    label: 'Focus',
    description: 'Markdown syntax stays hidden and is revealed around your cursor as you edit.',
  },
  {
    value: 'show',
    label: 'Show',
    description: 'Markdown syntax characters are always visible.',
  },
]

export function EditorSection(): ReactElement {
  const { settings, updateSettings } = useSettings()

  return (
    <SettingsSection title="Editor">
      <fieldset className="px-4 py-3.5">
        <legend className="float-left text-sm font-medium text-[color:var(--text)]">
          Markdown syntax
        </legend>
        <p className="clear-left mt-0.5 text-xs text-[color:var(--text-muted)]">
          How literal markdown characters (#, **, [[ ]]) are displayed while editing.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {MARKDOWN_SYNTAX_OPTIONS.map((option) => {
            const selected = settings.editorMarkdownSyntax === option.value
            return (
              <label
                key={option.value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-100',
                  selected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface-hover)]',
                )}
              >
                <input
                  type="radio"
                  name="editor-markdown-syntax"
                  value={option.value}
                  checked={selected}
                  onChange={() => updateSettings({ editorMarkdownSyntax: option.value })}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span
                    className={cn(
                      'block text-sm font-medium',
                      selected && 'text-[color:var(--accent-soft-text)]',
                    )}
                  >
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-[color:var(--text-muted)]">
                    {option.description}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
    </SettingsSection>
  )
}
