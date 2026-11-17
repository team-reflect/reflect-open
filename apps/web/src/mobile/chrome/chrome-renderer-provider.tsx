import { useMemo, type ReactElement, type ReactNode } from 'react'
import { ChromeRendererContext } from '@/mobile/chrome/chrome-renderer.ts'
import { createNativeChromeRenderer } from '@/mobile/chrome/native/native-chrome-renderer.tsx'
import { WEB_CHROME_RENDERER } from '@/mobile/chrome/web/web-chrome-renderer.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Picks the chrome renderer: the native one when the shell draws the
 * chrome, the web one otherwise.
 */
export function ChromeRendererProvider({ children }: { children: ReactNode }): ReactElement {
  const { nativeChrome } = useAppServices()
  const renderer = useMemo(
    () => (nativeChrome.enabled ? createNativeChromeRenderer(nativeChrome) : WEB_CHROME_RENDERER),
    [nativeChrome],
  )
  return <ChromeRendererContext value={renderer}>{children}</ChromeRendererContext>
}
