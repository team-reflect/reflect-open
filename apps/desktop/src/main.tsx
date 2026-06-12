import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { installTauriBridge } from '@/lib/tauri-bridge'
import { PlatformRoot } from '@/platform-root'
import { SettingsProvider } from '@/providers/settings-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import '@/styles/index.css'

installTauriBridge()
registerAppCommands()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root was not found')
}

// Platform-neutral providers only — everything desktop- or mobile-specific
// (update checks, drag region, graph bootstrap mode) lives inside the lazy
// trees behind the PlatformRoot gate (Plan 19).
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <ThemeProvider>
          <PlatformRoot />
        </ThemeProvider>
      </SettingsProvider>
    </QueryClientProvider>
  </StrictMode>,
)
