import type { ReactElement } from 'react'
import { AboutSection } from './settings/about-section'
import { AiModelsSection } from './settings/ai-models-section'
import { AllNotesSection } from './settings/all-notes-section'
import { AppearanceSection } from './settings/appearance-section'
import { EditorSection } from './settings/editor-section'
import { KeyboardSection } from './settings/keyboard-section'
import { SearchSection } from './settings/search-section'

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
        <AllNotesSection />
        <SearchSection />
        <AiModelsSection />
        <KeyboardSection />
        <AboutSection />
      </div>
    </div>
  )
}
