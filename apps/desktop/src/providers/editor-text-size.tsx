import { useEffect, type ReactElement } from 'react'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Applies the editor reading size to the document root.
 *
 * Mirrors the `editorTextSize` setting onto `[data-editor-text-size]` on
 * `<html>`, which `styles/index.css` maps to the `--editor-font-size`
 * variable the editor reads. This is a side-effect-only component (it renders
 * nothing): like the theme's `.dark` toggle, the preference lives in the
 * settings document, so a choice made anywhere persists across launches and
 * applies to every editor surface (desktop and mobile) at once.
 */
export function EditorTextSizeEffect(): ReactElement | null {
  const { settings } = useSettings()
  const textSize = settings.editorTextSize

  useEffect(() => {
    document.documentElement.setAttribute('data-editor-text-size', textSize)
  }, [textSize])

  return null
}
