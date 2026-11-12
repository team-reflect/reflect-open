import type { ReactElement } from 'react'
import type { EditorMarkdownSyntax, EditorTextSize } from '@reflect/core'
import { cn } from '@/lib/utils.ts'
import {
  useEditorBulletAfterHeading,
  useEditorDefaultBullet,
  useEditorFullWidth,
  useEditorMarkdownSyntax,
  useEditorSmoothCaretAnimation,
  useEditorSpellCheck,
  useEditorTextSize,
  useSettingsService,
} from '@/providers/settings-provider.tsx'
import { SettingsField } from './field.tsx'
import { KeyboardShortcutsField } from './keyboard-shortcuts-field.tsx'
import { SettingsOptionCard } from './option-card.tsx'
import { SettingsSection } from './section.tsx'
import { SettingsSwitchField } from './switch-field.tsx'

interface MarkdownSyntaxOption {
  value: EditorMarkdownSyntax
  label: string
  description: string
}

const MARKDOWN_SYNTAX_OPTIONS: MarkdownSyntaxOption[] = [
  {
    value: 'hide',
    label: 'Hide',
    description: 'Always hidden',
  },
  {
    value: 'hybrid',
    label: 'Hybrid',
    description: 'Only around the cursor',
  },
  {
    value: 'show',
    label: 'Show',
    description: 'Always visible',
  },
]

interface TextSizeOption {
  value: EditorTextSize
  label: string
  description: string
}

const TEXT_SIZE_OPTIONS: TextSizeOption[] = [
  {
    value: 'small',
    label: 'Small',
    description: 'Compact',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Default',
  },
  {
    value: 'large',
    label: 'Large',
    description: 'Comfortable',
  },
]

export function EditorSection(): ReactElement {
  const editorMarkdownSyntax = useEditorMarkdownSyntax()
  const editorTextSize = useEditorTextSize()
  const editorFullWidth = useEditorFullWidth()
  const editorSpellCheck = useEditorSpellCheck()
  const editorDefaultBullet = useEditorDefaultBullet()
  const editorBulletAfterHeading = useEditorBulletAfterHeading()
  const editorSmoothCaretAnimation = useEditorSmoothCaretAnimation()
  const settingsService = useSettingsService()

  return (
    <SettingsSection id="editor">
      <SettingsField
        legend="Markdown syntax"
        description="How literal markdown characters (**, `, etc.) are displayed while editing."
      >
        <div className="mt-3 @container">
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
            {MARKDOWN_SYNTAX_OPTIONS.map((option) => {
              const selected = editorMarkdownSyntax === option.value
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
                    onChange={() => settingsService.update({ editorMarkdownSyntax: option.value })}
                    className="mt-0.5 shrink-0 accent-accent"
                  />
                </SettingsOptionCard>
              )
            })}
          </div>
        </div>
      </SettingsField>

      <SettingsField legend="Text size" description="The reading size of the note editor.">
        <div className="mt-3 @container">
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
            {TEXT_SIZE_OPTIONS.map((option) => {
              const selected = editorTextSize === option.value
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
                    name="editor-text-size"
                    value={option.value}
                    checked={selected}
                    onChange={() => settingsService.update({ editorTextSize: option.value })}
                    className="mt-0.5 shrink-0 accent-accent"
                  />
                </SettingsOptionCard>
              )
            })}
          </div>
        </div>
      </SettingsField>

      <SettingsSwitchField
        legend="Full-width notes"
        description="Stretch note text across the window with a small edge margin."
        checked={editorFullWidth}
        onCheckedChange={(checked) => settingsService.update({ editorFullWidth: checked })}
      />

      <SettingsSwitchField
        legend="Spell check"
        description="Underline misspelled words while you type."
        checked={editorSpellCheck}
        onCheckedChange={(checked) => settingsService.update({ editorSpellCheck: checked })}
      />

      <SettingsSwitchField
        legend="Start with a bullet"
        description="New and empty notes open with a single bullet point, ready to type."
        checked={editorDefaultBullet}
        onCheckedChange={(checked) => settingsService.update({ editorDefaultBullet: checked })}
      />

      <SettingsSwitchField
        legend="Bullet after a heading"
        description="Pressing Return at the end of a heading starts a new bullet."
        checked={editorBulletAfterHeading}
        onCheckedChange={(checked) => settingsService.update({ editorBulletAfterHeading: checked })}
      />

      <SettingsSwitchField
        legend="Smooth caret animation"
        description="Animate the text cursor as it moves while editing."
        checked={editorSmoothCaretAnimation}
        onCheckedChange={(checked) => {
          return settingsService.update({ editorSmoothCaretAnimation: checked })
        }}
      />

      <KeyboardShortcutsField />
    </SettingsSection>
  )
}
