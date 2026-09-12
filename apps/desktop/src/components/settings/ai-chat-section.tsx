import type { ReactElement } from 'react'
import { CHAT_SYSTEM_PROMPT_MAX_LENGTH, normalizeChatSystemPrompt } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'
import { SettingsSection } from './section'
import { SettingsTextareaField } from './textarea-field'

/** Additional user instructions applied to every AI chat turn. */
export function AiChatSection(): ReactElement {
  const { settings, updateSettings } = useSettings()

  return (
    <SettingsSection id="ai-chat">
      <SettingsTextareaField
        legend="System prompt"
        description="Additional instructions sent with every AI chat. Reflect’s note-search, citation, and privacy rules still apply."
        ariaLabel="System prompt"
        value={settings.chatSystemPrompt}
        placeholder="Be concise. Challenge my assumptions and ask clarifying questions."
        maxLength={CHAT_SYSTEM_PROMPT_MAX_LENGTH}
        rows={6}
        normalize={normalizeChatSystemPrompt}
        onSave={(chatSystemPrompt) => updateSettings({ chatSystemPrompt })}
      />
    </SettingsSection>
  )
}
