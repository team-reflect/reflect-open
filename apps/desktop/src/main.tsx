// Must stay the first import: see `boot.ts`.
import { reactRootOptions } from '@/boot'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { installNativeMenu } from '@/lib/native-menu/menu'
import { PlatformRoot, warmPlatformRoot } from '@platform-root'
import { EditorFullWidthEffect } from '@/providers/editor-full-width'
import { EditorTextSizeEffect } from '@/providers/editor-text-size'
import { SettingsProvider } from '@/providers/settings-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import '@/styles/index.css'

// Start the platform root's boot-critical work (on mobile, the
// iCloud-container resolve) now, ahead of React's first render.
warmPlatformRoot()
registerAppCommands()
installNativeMenu().catch((cause: unknown) => {
  console.error('failed to install the native menu', cause)
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root was not found')
}

// Platform-neutral providers only — everything desktop- or mobile-specific
// (update checks, drag region, graph bootstrap mode) lives inside the lazy
// trees behind the PlatformRoot gate (Plan 19).
createRoot(rootElement, reactRootOptions).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <EditorFullWidthEffect />
        <EditorTextSizeEffect />
        <ThemeProvider>
          <PlatformRoot />
        </ThemeProvider>
      </SettingsProvider>
    </QueryClientProvider>
  </StrictMode>,
)
