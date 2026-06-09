import { useCallback, useEffect, useState } from 'react'
import { getAppVersion, isAppError, notePath, readNote, writeNote, type GraphInfo } from '@reflect/core'
import { AppShell } from '@/components/app-shell'
import { NotePane } from '@/components/note-pane'
import { useTheme } from '@/providers/theme-provider'

/** The fixed note the workspace opens until Plan 06 brings navigation. */
const WELCOME_PATH = notePath('welcome')

/** Seed content, written once when the welcome note doesn't exist yet. */
const WELCOME_NOTE = `# Welcome to Reflect

This is the **meowdown** editor — markdown you can _see_, backed by plain files.
Everything you type here is saved to \`${WELCOME_PATH}\` in your graph.

Daily notes link to people and ideas with [[Wiki Links]], and to dates like [[2026-06-09]].

- capture first
- organize later

> Backlinks are the organizing primitive.
`

const CLOUD_LABELS: Record<string, string> = {
  icloud: 'iCloud Drive',
  dropbox: 'Dropbox',
  googleDrive: 'Google Drive',
  oneDrive: 'OneDrive',
}

interface GraphWorkspaceProps {
  graph: GraphInfo
}

/**
 * The main surface once a graph is open: the three-region shell with a header
 * (graph name, a cloud-sync warning when relevant, version, theme toggle) and
 * the editor. Daily-note wiring + persistence land in Plan 06.
 */
export function GraphWorkspace({ graph }: GraphWorkspaceProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const [version, setVersion] = useState<string | null>(null)
  // Set once the welcome note is known to exist (created on first open), so the
  // editor only ever binds to a real file. Keyed off the graph root: switching
  // graphs re-ensures in the new one.
  const [openPath, setOpenPath] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const result = await getAppVersion()
        if (active) {
          setVersion(result)
        }
      } catch {
        if (active) {
          setVersion(null)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    setOpenPath(null)
    void (async () => {
      try {
        await readNote(WELCOME_PATH)
      } catch (err) {
        if (isAppError(err) && err.kind === 'notFound') {
          try {
            await writeNote(WELCOME_PATH, WELCOME_NOTE, graph.generation)
          } catch {
            // fall through — NotePane surfaces the open error
          }
        }
        // Any other failure also falls through: always mount NotePane so its
        // own read attempt can show the real error instead of an endless
        // "Opening note…".
      } finally {
        if (active) {
          setOpenPath(WELCOME_PATH)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [graph.root, graph.generation])

  const toggleTheme = useCallback((): void => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }, [resolvedTheme, setTheme])

  const cloudLabel = graph.cloudSync ? (CLOUD_LABELS[graph.cloudSync] ?? graph.cloudSync) : null

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
          <h1 className="truncate text-sm font-semibold" title={graph.root}>
            {graph.name}
          </h1>
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

        {cloudLabel ? (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
            This graph is inside {cloudLabel}. Reflect syncs via GitHub — a cloud-synced
            folder is unsupported and can corrupt the local index. Consider moving it to a
            non-synced location.
          </div>
        ) : null}

        <div className="mx-auto w-full max-w-2xl flex-1 overflow-auto px-6 py-8">
          {openPath ? (
            <NotePane path={openPath} />
          ) : (
            <div className="text-sm text-[color:var(--text-muted)]">Opening note…</div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
