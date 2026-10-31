import { useEffect } from 'react'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Keep a note window's OS title on its current note (route changes and
 * renames alike — the title rides the same index row the pane shows), so
 * the Window menu and ⌘-backtick cycling can tell windows apart. `null`
 * while the title is unknown (row still loading, or a route without one)
 * falls back to the app name.
 */
export function useNoteWindowTitle(title: string | null): void {
  const { window: appWindow } = useAppServices()
  useEffect(() => {
    void appWindow.setTitle(title ?? 'Reflect')
  }, [appWindow, title])
}
