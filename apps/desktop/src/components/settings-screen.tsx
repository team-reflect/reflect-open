import type { ReactElement } from 'react'
import type { EditorMarkMode } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'

/**
 * The settings screen (a routed view, like notes — reached via ⌘, or the
 * palette's "Open settings"). Every control applies instantly through
 * {@link useSettings}; there is no save button.
 */

interface MarkModeOption {
  value: EditorMarkMode
  label: string
  description: string
}

const MARK_MODE_OPTIONS: MarkModeOption[] = [
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

export function SettingsScreen(): ReactElement {
  const { settings, updateSettings } = useSettings()

  return (
    <div aria-label="Settings">
      <h1 className="text-lg font-semibold">Settings</h1>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-secondary)]">
          Editor
        </h2>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Markdown syntax</legend>
          <p className="mt-1 text-xs text-[color:var(--text-muted)]">
            How literal markdown characters (#, **, [[ ]]) are displayed while editing.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {MARK_MODE_OPTIONS.map((option) => {
              const selected = settings.editorMarkMode === option.value
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 ${
                    selected
                      ? 'border-[var(--accent)] bg-[var(--accent-soft,rgb(99_102_241/0.08))]'
                      : 'border-black/10 dark:border-white/10'
                  }`}
                >
                  <input
                    type="radio"
                    name="editor-mark-mode"
                    value={option.value}
                    checked={selected}
                    onChange={() => updateSettings({ editorMarkMode: option.value })}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-xs text-[color:var(--text-muted)]">
                      {option.description}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      </section>
    </div>
  )
}
