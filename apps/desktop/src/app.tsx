import { useEffect, useState } from 'react'
import { getAppVersion } from '@reflect/core'
import { AppShell } from '@/components/app-shell'
import { useTheme } from '@/providers/theme-provider'

/**
 * Root application component. For Plan 01 it renders the empty three-region
 * shell and exercises the IPC boundary via the `app_version` round-trip; real
 * surfaces (editor, daily notes, search) arrive in later plans.
 */
export function App() {
  const { resolvedTheme, setTheme } = useTheme()
  const [version, setVersion] = useState<string | null>(null)

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

  const toggleTheme = (): void => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  return (
    <AppShell
      rail={
        <span className="text-xs font-semibold text-[color:var(--text-secondary)]">
          R
        </span>
      }
      sidebar={
        <div className="p-4 text-sm text-[color:var(--text-secondary)]">Context</div>
      }
    >
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">Reflect</h1>
        <p className="text-sm text-[color:var(--text-secondary)]">
          App version: {version ?? '—'}
        </p>
        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--text-on-brand,#fff)]"
        >
          Toggle theme ({resolvedTheme})
        </button>
      </div>
    </AppShell>
  )
}
