import type { ReactElement } from 'react'
import type { ThemePreference } from '@reflect/core'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { SettingsSection } from './section'

interface ThemeOption {
  value: ThemePreference
  label: string
  icon: LucideIcon
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

/**
 * Theme picker as radio cards (the original app's idiom). Edits the settings
 * document directly — the ThemeProvider applies whatever is persisted, so
 * this section needs no theme context of its own.
 */
export function AppearanceSection(): ReactElement {
  const { settings, updateSettings } = useSettings()

  return (
    <SettingsSection title="Appearance">
      <fieldset className="px-4 py-3.5">
        <legend className="float-left text-sm font-medium text-[color:var(--text)]">Theme</legend>
        <p className="clear-left mt-0.5 text-xs text-[color:var(--text-muted)]">
          System follows your OS appearance. Saved with your settings.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const selected = settings.theme === value
            return (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border px-3 py-3 transition-colors duration-100',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus-ring)]',
                  selected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[color:var(--accent-soft-text)]'
                    : 'border-[var(--border)] text-[color:var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                )}
              >
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={selected}
                  onChange={() => updateSettings({ theme: value })}
                  className="sr-only"
                />
                <Icon aria-hidden strokeWidth={1.75} className="size-4" />
                <span className="text-xs font-medium">{label}</span>
              </label>
            )
          })}
        </div>
      </fieldset>
    </SettingsSection>
  )
}
