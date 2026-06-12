import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '@/app'
import { WindowDragRegion } from '@/components/window-drag-region'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryClient } from '@/lib/query-client'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { installTauriBridge } from '@/lib/tauri-bridge'
import { GraphProvider } from '@/providers/graph-provider'
import { SettingsProvider } from '@/providers/settings-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import { UpdateProvider } from '@/providers/update-provider'
import '@/styles/index.css'

installTauriBridge()
registerAppCommands()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root was not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <ThemeProvider>
          <UpdateProvider>
            <GraphProvider>
              <TooltipProvider>
                <WindowDragRegion />
                <App />
              </TooltipProvider>
            </GraphProvider>
          </UpdateProvider>
        </ThemeProvider>
      </SettingsProvider>
    </QueryClientProvider>
  </StrictMode>,
)
