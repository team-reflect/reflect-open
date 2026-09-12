import type { ReactElement } from 'react'
import { TRANSCRIPTION_PROMPT_MAX_LENGTH, normalizeTranscriptionPrompt } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'
import { SettingsSection } from './section'
import { SettingsSwitchField } from './switch-field'
import { SettingsTextareaField } from './textarea-field'

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
      <SettingsTextareaField
        legend="Transcription helper text"
        description="Context sent to your transcription provider with every audio memo, such as names it tends to misspell."
        ariaLabel="Transcription helper text"
        value={settings.transcriptionPrompt}
        placeholder="This transcription mentions the following names:"
        maxLength={TRANSCRIPTION_PROMPT_MAX_LENGTH}
        rows={2}
        normalize={normalizeTranscriptionPrompt}
        onSave={(transcriptionPrompt) => updateSettings({ transcriptionPrompt })}
        resettable={false}
      />
    </SettingsSection>
  )
}
