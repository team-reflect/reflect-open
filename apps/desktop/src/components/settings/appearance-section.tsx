import type { ReactElement } from 'react'
import type { ThemePreference } from '@reflect/core'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { SettingsField } from './field'
import { SettingsOptionCard } from './option-card'
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
    <SettingsSection id="appearance">
      <SettingsField
        legend="Theme"
        description="System follows your OS appearance. Saved with your settings."
      >
        <div className="mt-3 grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const selected = settings.theme === value
            return (
              <SettingsOptionCard
                key={value}
                selected={selected}
                className={cn(
                  'flex-col items-center gap-1.5 px-3 py-3',
                  selected ? 'text-accent-soft-text' : 'text-text-secondary',
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
              </SettingsOptionCard>
            )
          })}
        </div>
      </SettingsField>
    </SettingsSection>
  )
}
