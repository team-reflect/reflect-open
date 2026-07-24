import { lazy, StrictMode, Suspense, useEffect, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { hasBridge, type DiagnosticsStatus } from '@reflect/core'
import { queryClient } from '@/lib/query-client'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { prepareApplicationStartup } from '@/lib/diagnostics-bootstrap'
import { initializeExceptionTelemetry } from '@/lib/exception-telemetry'
import { installNativeMenu } from '@/lib/native-menu/menu'
import { installTauriBridge } from '@/lib/tauri-bridge'
import { PlatformRoot, warmPlatformRoot } from '@/platform-root'
import { EditorFullWidthEffect } from '@/providers/editor-full-width'
import { EditorTextSizeEffect } from '@/providers/editor-text-size'
import { SettingsProvider } from '@/providers/settings-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import '@/styles/index.css'

const reactRootOptions = initializeExceptionTelemetry()
installTauriBridge()
const diagnosticsEnabled =
  hasBridge() && import.meta.env.TAURI_ENV_PLATFORM === 'ios'
// Start the ordinary boot-critical work only once native recovery mode has
// cleared it. Safe mode must not resolve iCloud or mount a graph.
const diagnosticsStartup = prepareApplicationStartup(diagnosticsEnabled, warmPlatformRoot)
registerAppCommands()
installNativeMenu().catch((cause: unknown) => {
  console.error('failed to install the native menu', cause)
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root was not found')
}

const DiagnosticsRecovery = lazy(() =>
  import('@/mobile/diagnostics-recovery').then((module) => ({
    default: module.DiagnosticsRecovery,
  })),
)

function AppBootstrap(): ReactElement {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsStatus | null>(null)

  useEffect(() => {
    let active = true
    void diagnosticsStartup.then((status) => {
      if (active) {
        setDiagnostics(status)
      }
    })
    return () => {
      active = false
    }
  }, [])

  if (diagnostics === null) {
    return <div className="h-screen w-screen" />
  }
  if (diagnostics.safeMode) {
    return (
      <Suspense fallback={<div className="h-screen w-screen" />}>
        <DiagnosticsRecovery />
      </Suspense>
    )
  }

  // Platform-neutral providers only — everything desktop- or mobile-specific
  // (update checks, drag region, graph bootstrap mode) lives inside the lazy
  // trees behind the PlatformRoot gate (Plan 19).
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <EditorFullWidthEffect />
        <EditorTextSizeEffect />
        <ThemeProvider>
          <PlatformRoot />
        </ThemeProvider>
      </SettingsProvider>
    </QueryClientProvider>
  )
}

createRoot(rootElement, reactRootOptions).render(
  <StrictMode>
    <AppBootstrap />
  </StrictMode>,
)
