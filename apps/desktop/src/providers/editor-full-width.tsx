import { useEffect, type ReactElement } from 'react'
import { useSettings } from '@/providers/settings-provider'

/**
 * Applies the desktop note-width preference to every note surface.
 *
 * The shared `.reflect-content-gutter` class is used by daily notes,
 * standalone notes, and secondary note windows. Mirroring the setting onto
 * the document root lets one CSS variable update all of those surfaces while
 * leaving the mobile-specific gutter unchanged.
 */
export function EditorFullWidthEffect(): ReactElement | null {
  const { settings } = useSettings()
  const fullWidth = settings.editorFullWidth

  useEffect(() => {
    const root = document.documentElement
    root.dataset['editorFullWidth'] = String(fullWidth)
    return () => {
      delete root.dataset['editorFullWidth']
    }
  }, [fullWidth])

  return null
}
