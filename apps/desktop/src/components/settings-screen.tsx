import type { ReactElement } from 'react'
import { AboutSection } from './settings/about-section.tsx'
import { AgentsSection } from './settings/agents-section.tsx'
import { AiChatSection } from './settings/ai-chat-section.tsx'
import { AiPromptsSection } from './settings/ai-prompts-section.tsx'
import { AiProvidersSection } from './settings/ai-providers-section.tsx'
import { AllNotesSection } from './settings/all-notes-section.tsx'
import { AppearanceSection } from './settings/appearance-section.tsx'
import { AudioMemosSection } from './settings/audio-memos-section.tsx'
import { DateTimeSection } from './settings/date-time-section.tsx'
import { DestructiveSection } from './settings/destructive-section.tsx'
import { EditorSection } from './settings/editor-section.tsx'
import { ImportSection } from './settings/import-section.tsx'
import { IntegrationsSection } from './settings/integrations-section.tsx'
import { SearchSection } from './settings/search-section.tsx'
import { SyncSection } from './settings/sync-section.tsx'
import { TemplatesSection } from './settings/templates-section.tsx'

/**
 * The settings screen (a routed view, like notes — reached via ⌘, or the
 * palette's "Open settings"). Every control applies instantly through the
 * settings provider; there is no save button.
 */
export function SettingsScreen(): ReactElement {
  return (
    <div aria-label="Settings" data-testid="settings-screen">
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
