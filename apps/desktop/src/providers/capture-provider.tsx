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
    const controller = createCaptureController({
      generation: graph.generation,
      getProviders: () => providersRef.current,
    })
    // Registration (the pointer-file rewrite) completes BEFORE the first
    // drain: on a graph switch this repoints the host at the new graph as
    // early as possible, instead of draining here while the pointer still
    // names the old one. (The host reads the pointer per capture in its own
    // process, so a capture racing the rewrite can still spool to the
    // previous graph's inbox — it drains when that graph next opens.)
    // Best-effort: a failed registration must not block the drain — captures
    // already spooled must land regardless, and the extension surfaces
    // "host not found" with install guidance on its side.
    const registered = hasBridge()
      ? captureHostRegister().catch((cause: unknown) => {
          console.error('capture host registration failed:', cause)
        })
      : Promise.resolve()
    void registered.then(() => {
      controller.start() // a no-op if the effect tore down while registering
    })
    return () => {
      controller.dispose()
    }
  }, [graph.generation])

  return <>{children}</>
}
