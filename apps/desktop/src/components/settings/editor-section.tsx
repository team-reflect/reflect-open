import type { ReactElement } from 'react'
import type { EditorMarkdownSyntax } from '@reflect/core'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { SettingsField } from './field'
import { SettingsOptionCard } from './option-card'
import { SettingsSection } from './section'
import { SettingsSwitchField } from './switch-field'

interface MarkdownSyntaxOption {
  value: EditorMarkdownSyntax
  label: string
  description: string
}

const MARKDOWN_SYNTAX_OPTIONS: MarkdownSyntaxOption[] = [
  {
    value: 'hide',
    label: 'Hide',
    description: 'Markdown syntax characters stay hidden while you edit.',
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
    <SettingsSection id="editor">
      <SettingsField
        legend="Markdown syntax"
        description="How literal markdown characters (#, **, [[ ]]) are displayed while editing."
      >
        <div className="mt-3 grid grid-cols-2 gap-2">
          {MARKDOWN_SYNTAX_OPTIONS.map((option) => {
            const selected = settings.editorMarkdownSyntax === option.value
            return (
              <SettingsOptionCard
                key={option.value}
                selected={selected}
                className="items-start justify-between gap-3 px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
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
                <input
                  type="radio"
                  name="editor-markdown-syntax"
                  value={option.value}
                  checked={selected}
                  onChange={() => updateSettings({ editorMarkdownSyntax: option.value })}
                  className="mt-0.5 shrink-0 accent-accent"
                />
              </SettingsOptionCard>
            )
          })}
        </div>
      </SettingsField>

      <SettingsSwitchField
        legend="Spell check"
        description="Underline misspelled words while you type."
        checked={settings.editorSpellCheck}
        onCheckedChange={(checked) => updateSettings({ editorSpellCheck: checked })}
      />

      <SettingsSwitchField
        legend="Start with a bullet"
        description="New and empty notes open with a single bullet point, ready to type."
        checked={settings.editorDefaultBullet}
        onCheckedChange={(checked) => updateSettings({ editorDefaultBullet: checked })}
      />

      <SettingsSwitchField
        legend="Bullet after a heading"
        description="Pressing Return at the end of a heading starts a new bullet."
        checked={settings.editorBulletAfterHeading}
        onCheckedChange={(checked) => updateSettings({ editorBulletAfterHeading: checked })}
      />
    </SettingsSection>
  )
}
