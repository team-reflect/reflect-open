import { useEffect, type ReactElement } from 'react'
import { useSettings } from '@/providers/settings-provider'

/** Exposes the persisted direction preference to native read-only surfaces. */
export function EditorTextDirectionEffect(): ReactElement | null {
  const { settings } = useSettings()
  const direction = settings.editorTextDirection

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-editor-text-direction', direction)
    return () => root.removeAttribute('data-editor-text-direction')
  }, [direction])

  return null
}
