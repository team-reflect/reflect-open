import { useEffect, type ReactElement } from 'react'
import { useEditorFullWidth } from '@/providers/settings-provider.tsx'

/**
 * Applies the desktop note-width preference to every note surface.
 *
 * Mirrors the setting onto the document root, so one CSS variable updates
 * every surface with the shared `.reflect-content-gutter` class. The
 * mobile-specific gutter is unchanged.
 */
export function EditorFullWidthEffect(): ReactElement | null {
  const fullWidth = useEditorFullWidth()

  useEffect(() => {
    const root = document.documentElement
    root.dataset['editorFullWidth'] = String(fullWidth)
    return () => {
      delete root.dataset['editorFullWidth']
    }
  }, [fullWidth])

  return null
}
