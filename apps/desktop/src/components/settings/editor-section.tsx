import type { ReactElement } from 'react'
import type { EditorMarkdownSyntax } from '@reflect/core'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { SettingsField } from './field'
import { SettingsOptionCard } from './option-card'
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
      <SettingsField
        legend="Markdown syntax"
        description="How literal markdown characters (#, **, [[ ]]) are displayed while editing."
      >
        <div className="mt-3 flex flex-col gap-2">
          {MARKDOWN_SYNTAX_OPTIONS.map((option) => {
            const selected = settings.editorMarkdownSyntax === option.value
            return (
              <SettingsOptionCard
                key={option.value}
                selected={selected}
                className="items-start gap-3 px-3 py-2.5"
              >
                <input
                  type="radio"
                  name="editor-markdown-syntax"
                  value={option.value}
                  checked={selected}
                  onChange={() => updateSettings({ editorMarkdownSyntax: option.value })}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span
                    className={cn(
                      'block text-sm font-medium',
                      selected && 'text-accent-soft-text',
                    )}
                  >
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {option.description}
                  </span>
                </span>
              </SettingsOptionCard>
            )
          })}
        </div>
      </SettingsField>

      <SettingsField
        legend="Spell check"
        description="Underline misspelled words while you type."
      >
        <div className="mt-3">
          <Switch
            aria-label="Spell check"
            checked={settings.editorSpellCheck}
            onCheckedChange={(checked) => updateSettings({ editorSpellCheck: checked })}
          />
        </div>
      </SettingsField>
    </SettingsSection>
  )
}
