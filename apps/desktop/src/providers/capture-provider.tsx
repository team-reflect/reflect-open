import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { captureHostRegister, hasBridge, type AiProvidersState, type GraphInfo } from '@reflect/core'
import { createCaptureController } from '@/lib/capture-controller'
import { useSettings } from '@/providers/settings-provider'

/**
 * Mounts the link-capture lifecycle for the open graph (Plan 11): registers
 * the native-messaging host (pointer file + browser manifests, rewritten on
 * every graph open so app moves self-heal) and runs the
 * {@link createCaptureController} drain/enrich loop. No UI — capture has no
 * in-app surface; the Chrome extension is the front end and the daily note
 * is the output.
 */

interface CaptureProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function CaptureProvider({ graph, children }: CaptureProviderProps): ReactElement {
  const { settings } = useSettings()

  // Read lazily at the start of every pass — a key added in Settings
  // mid-session must be seen without rebuilding the controller.
  const providersRef = useRef<AiProvidersState>({
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  })
  providersRef.current = {
    providers: settings.aiProviders,
    defaultProviderId: settings.defaultAiProviderId,
  }

  useEffect(() => {
    if (hasBridge()) {
      // Best-effort: a failed registration must not block the workspace —
      // the extension reports "host not found" with install guidance instead.
      captureHostRegister().catch((cause: unknown) => {
        console.error('capture host registration failed:', cause)
      })
    }
    const controller = createCaptureController({
      generation: graph.generation,
      getProviders: () => providersRef.current,
    })
    controller.start()
    return () => {
      controller.dispose()
    }
  }, [graph.generation])

  return <>{children}</>
}
