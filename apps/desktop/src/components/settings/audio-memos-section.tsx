import type { ReactElement } from 'react'
import { useSettings } from '@/providers/settings-provider'
import { SettingsSection } from './section'
import { SettingsSwitchField } from './switch-field'

/** Preferences for recording enrichment after the raw audio is safely stored. */
export function AudioMemosSection(): ReactElement {
  const { settings, updateSettings } = useSettings()

  return (
    <SettingsSection id="audio-memos">
      <SettingsSwitchField
        legend="Transcription auto-format"
        description="Use AI to add punctuation, paragraphs, and light Markdown while preserving the original meaning."
        checked={settings.transcriptionFormat}
        onCheckedChange={(transcriptionFormat) => updateSettings({ transcriptionFormat })}
      />
    </SettingsSection>
  )
}
