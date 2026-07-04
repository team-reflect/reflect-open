import { type ReactElement, type ReactNode } from 'react'
import { Folder, FolderInput, FolderPlus, Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGraphColors } from '@/hooks/use-graph-colors'
import { graphColorCss } from '@/lib/graph-colors'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'

/**
 * Steps a Reflect V1 user follows to bring their notes across. Kept as data so
 * the numbered list stays readable and the test can assert on the key actions.
 * The V1 menu path ("Settings → Graph → Export") is V1's own label, quoted
 * verbatim so it matches what the user sees in the old app.
 */
const V1_STEPS: ReactNode[] = [
  <>
    In Reflect v1, go to <Emphasis>Settings → Graph → Export</Emphasis> and export a{' '}
    <Emphasis>“Reflect Open folder”</Emphasis>.
  </>,
  <>Unzip the file and move the folder wherever you’d like to keep your notes.</>,
  <>
    Click <Emphasis>Open exported folder</Emphasis> below and select it.
  </>,
]

function Emphasis({ children }: { children: ReactNode }): ReactElement {
  return <span className="font-medium text-text">{children}</span>
}

function shouldShowIcloudDriveTip(): boolean {
  return import.meta.env.TAURI_ENV_PLATFORM === 'darwin'
}

/**
 * First-run / no-graph screen. Splits the two audiences the old single button
 * blurred together — people new to Reflect (pick a folder, start fresh) and
 * people migrating from Reflect V1 (export → unzip → open the folder) — into
 * two equal, self-explanatory sections. Both ultimately call the same folder
 * picker ({@link useGraph}'s `pickAndOpen`): a fresh empty folder seeds a
 * welcome note, an exported V1 folder rebuilds its index from the files.
 *
 * "Graph" is deliberately absent here — newcomers don't know the word yet; it
 * is reintroduced once they're inside the app. Returning users still see their
 * Recent folders. A recent's folder icon takes the graph's identity color once
 * one is chosen (sidebar footer → Graph color); until then it stays muted.
 */
export function GraphChooser(): ReactElement {
  const { recents, error, pickAndOpen, openRecent, forget } = useGraph()
  const { colorFor } = useGraphColors()
  const showIcloudDriveTip = shouldShowIcloudDriveTip()

  return (
    <div className="flex h-screen w-screen overflow-auto bg-surface-app p-8">
      {/* Auto margins (not items-center) so the content centers when it fits but
          scrolls from the top when the recents list outgrows the viewport —
          flex centering would clip the overflowing top edge. */}
      <div className="m-auto w-full max-w-2xl space-y-8">
        <div className="space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold text-text">Welcome to Reflect</h1>
          <p className="text-sm text-text-secondary">
            Reflect keeps your notes as plain markdown files in a folder you choose.
          </p>
        </div>

        <div className="grid items-stretch gap-4 sm:grid-cols-2">
          {/* New to Reflect — start fresh in an empty folder. */}
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
            <div className="space-y-1.5">
              <h2 className="text-base font-semibold text-text">New to Reflect</h2>
              <p className="text-sm text-text-secondary">
                Pick a folder on your computer and Reflect will keep all of your notes
                there. An empty folder is perfect.
              </p>
            </div>
            <Button type="button" className="mt-auto w-full" onClick={() => void pickAndOpen()}>
              <FolderPlus aria-hidden strokeWidth={1.75} />
              Choose a folder…
            </Button>
          </section>

          {/* Coming from Reflect V1 — guided export → unzip → open. */}
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
            <div className="space-y-1.5">
              <h2 className="text-base font-semibold text-text">Coming from Reflect v1</h2>
              <p className="text-sm text-text-secondary">
                Bring your existing notes across in three steps.
              </p>
            </div>
            <ol className="space-y-2.5">
              {V1_STEPS.map((step, index) => (
                <li key={index} className="flex gap-2.5 text-sm text-text-secondary">
                  <span
                    aria-hidden
                    className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-text-secondary"
                  >
                    {index + 1}
                  </span>
                  <span className="leading-5">{step}</span>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="outline"
              className="mt-auto w-full"
              onClick={() => void pickAndOpen()}
            >
              <FolderInput aria-hidden strokeWidth={1.75} />
              Open exported folder…
            </Button>
          </section>
        </div>

        {showIcloudDriveTip ? (
          <div className="mx-auto flex max-w-xl gap-2.5 text-sm leading-5 text-text-secondary">
            <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
            <p>
              <span className="font-medium text-text">Tip:</span> choose a folder in iCloud Drive
              and your notes back up automatically. On iPhone? Pick your notes folder inside{' '}
              <Emphasis>iCloud Drive → Reflect</Emphasis> to share notes with the iOS app.
            </p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {recents.length > 0 ? (
          <div className="mx-auto w-full max-w-sm space-y-2">
            <p className="px-2 text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
              Recent
            </p>
            <ul className="space-y-px">
              {recents.map((recent) => {
                const color = colorFor(recent.root)
                return (
                  <li
                    key={recent.root}
                    className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors duration-100 hover:bg-surface-hover"
                  >
                    <button
                      type="button"
                      onClick={() => void openRecent(recent.root)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <Folder
                        aria-hidden
                        strokeWidth={1.75}
                        className={cn('size-4 shrink-0', color === undefined && 'text-text-muted')}
                        style={color === undefined ? undefined : { color: graphColorCss(color) }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text">
                          {recent.name}
                        </span>
                        <span className="block truncate text-xs text-text-muted">
                          {recent.root}
                        </span>
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => void forget(recent.root)}
                      aria-label={`Forget ${recent.name}`}
                      className="shrink-0 text-text-muted opacity-0 transition-opacity duration-100 hover:text-text-secondary group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                    >
                      Forget
                    </Button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}
