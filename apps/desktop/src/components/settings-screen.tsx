import type { ReactElement } from 'react'
import { AboutSection } from './settings/about-section'
import { AgentsSection } from './settings/agents-section'
import { AiChatSection } from './settings/ai-chat-section'
import { AiPromptsSection } from './settings/ai-prompts-section'
import { AiProvidersSection } from './settings/ai-providers-section'
import { AllNotesSection } from './settings/all-notes-section'
import { AppearanceSection } from './settings/appearance-section'
import { AudioMemosSection } from './settings/audio-memos-section'
import { DateTimeSection } from './settings/date-time-section'
import { DestructiveSection } from './settings/destructive-section'
import { EditorSection } from './settings/editor-section'
import { ImportSection } from './settings/import-section'
import { IntegrationsSection } from './settings/integrations-section'
import { SearchSection } from './settings/search-section'
import { SyncSection } from './settings/sync-section'
import { TemplatesSection } from './settings/templates-section'

/**
 * The settings screen (a routed view, like notes — reached via ⌘, or the
 * palette's "Open settings"). Every control applies instantly through the
 * settings provider; there is no save button.
 */
export function SettingsScreen(): ReactElement {
  return (
    <div aria-label="Settings">
      <h1 className="text-lg font-semibold text-text">Settings</h1>
      <div className="mt-6">
        <AppearanceSection />
        <EditorSection />
        <DateTimeSection />
        <TemplatesSection />
        <AllNotesSection />
        <SearchSection />
        <AiProvidersSection />
        <AudioMemosSection />
        <AiChatSection />
        <AiPromptsSection />
        <AgentsSection />
        <IntegrationsSection />
        <SyncSection />
        <ImportSection />
        <AboutSection />
        <DestructiveSection />
      </div>
    </div>
  )
}
