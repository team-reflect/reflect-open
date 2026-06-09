import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppVersion } from '@reflect/core'
import { AppShell } from '@/components/app-shell'
import { NoteEditor } from '@/editor/note-editor'
import { useTheme } from '@/providers/theme-provider'

/** Sample note for the Plan 05 editor spike — exercises headings, marks, a list,
 * a quote, and `[[wiki links]]` (which render as plain text until Plan 07). */
const SAMPLE_NOTE = `# Welcome to Reflect

This is the **meowdown** editor — markdown you can _see_, backed by plain files.

Daily notes link to people and ideas with [[Wiki Links]], and to dates like [[2026-06-09]].

- capture first
- organize later

> Backlinks are the organizing primitive.
`

/**
 * Root application component. Renders the three-region shell, exercises the IPC
 * boundary via the `app_version` round-trip, and mounts the meowdown editor
 * (Plan 05 spike). Real daily-note wiring + persistence arrive in Plans 02/06.
 */
export function App() {
  const { resolvedTheme, setTheme } = useTheme()
  const [version, setVersion] = useState<string | null>(null)
  const markdownRef = useRef(SAMPLE_NOTE)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const result = await getAppVersion()
        if (active) {
          setVersion(result)
        }
      } catch {
        // `app_version` only resolves inside the Tauri shell; ignore in browser dev.
        if (active) {
          setVersion(null)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const toggleTheme = useCallback((): void => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }, [resolvedTheme, setTheme])

  const handleEditorChange = useCallback((markdown: string): void => {
    // Persistence lands in Plan 02/05; for the spike we just hold the latest value.
    markdownRef.current = markdown
  }, [])

  return (
    <AppShell
      rail={
        <span className="text-xs font-semibold text-[color:var(--text-secondary)]">R</span>
      }
      sidebar={
        <div className="p-4 text-sm text-[color:var(--text-secondary)]">Context</div>
      }
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-black/10 px-6 py-3 dark:border-white/10">
          <h1 className="text-sm font-semibold">Reflect</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[color:var(--text-muted)]">v{version ?? '—'}</span>
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-md border border-black/10 px-2.5 py-1 text-xs font-medium dark:border-white/10"
            >
              {resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode
            </button>
          </div>
        </header>

        <div className="mx-auto w-full max-w-2xl flex-1 overflow-auto px-6 py-8">
          <NoteEditor initialContent={SAMPLE_NOTE} onChange={handleEditorChange} />
        </div>
      </div>
    </AppShell>
  )
}
