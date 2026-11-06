import type { ReactElement } from 'react'
import { AboutSection } from './settings/about-section.tsx'
import { AccountsSection } from './settings/accounts-section.tsx'
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
import { GraphSection } from './settings/graph-section.tsx'
import { ImportSection } from './settings/import-section.tsx'
import { IntegrationsSection } from './settings/integrations-section.tsx'
import { SearchSection } from './settings/search-section.tsx'
import { SubscriptionSection } from './settings/subscription-section.tsx'
import { SyncSection } from './settings/sync-section.tsx'
import { TemplatesSection } from './settings/templates-section.tsx'
import { useIsSettingsSectionVisible } from './settings/use-visible-settings-sections.ts'

/**
 * The settings screen (a routed view, like notes — reached via ⌘, or the
 * palette's "Open settings"). Every control applies instantly through the
 * settings provider; there is no save button. Which platform-specific
 * sections show comes from {@link useIsSettingsSectionVisible}, the rule the
 * navigator follows too.
 */
export function SettingsScreen(): ReactElement {
  const isVisible = useIsSettingsSectionVisible()
  return (
    <div aria-label="Settings" data-testid="settings-screen">
      <h1 className="text-lg font-semibold text-text">Settings</h1>
      <div className="mt-6">
        {isVisible('graph') ? <GraphSection /> : null}
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
        <AccountsSection />
        {isVisible('import') ? <ImportSection /> : null}
        {isVisible('subscription') ? <SubscriptionSection /> : null}
        <AboutSection />
        {isVisible('destructive') ? <DestructiveSection /> : null}
      </div>
    </div>
  )
}
