import { useId, useState, type ReactElement } from 'react'
import { Cloud, FolderOpen, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cleanGraphName, graphNameFromRoot, graphRootForName, isGraphNameTaken } from '@/lib/graph-names'

const DEFAULT_ICLOUD_NOTES_NAME = 'Notes'

interface OnboardingIcloudSectionProps {
  /** The container is still resolving — render the pending row, not the form. */
  pending: boolean
  /** The container's `Documents/` root; null while {@link pending}. */
  documentsRoot: string | null
  /** Existing graphs inside the container (name-sorted). */
  graphs: string[]
  /** A choice is in flight somewhere on the screen — every control disables. */
  busy: boolean
  /** Which control kicked off the in-flight choice (a graph root, or the
   * parent's fixed tags) — only that one shows its spinner/pending label. */
  pendingChoice: string | null
  /** Open an existing container graph. */
  onOpen: (root: string) => void
  /** Create (and open) a new container graph at this root. */
  onCreate: (root: string) => void
}

/**
 * The onboarding screen's iCloud Drive card: the existing-graph list plus the
 * create-new form — or a single pending row while the container is still
 * resolving ("no iCloud" is only honest once the lookup finished). Owns the
 * create-name input state; the parent owns which choice is in flight.
 */
export function OnboardingIcloudSection(props: OnboardingIcloudSectionProps): ReactElement {
  const { pending, documentsRoot, graphs, busy, pendingChoice, onOpen, onCreate } = props
  const [typedName, setTypedName] = useState<string | null>(null)
  const nameId = useId()

  const name = typedName ?? ''
  const cleanName = cleanGraphName(name)
  const nameTaken = cleanName !== null && isGraphNameTaken(cleanName, graphs)

  function createDefault(): void {
    if (documentsRoot === null) {
      return
    }
    onCreate(graphRootForName(documentsRoot, DEFAULT_ICLOUD_NOTES_NAME))
  }

  function create(): void {
    if (documentsRoot === null || cleanName === null || nameTaken) {
      return
    }
    onCreate(graphRootForName(documentsRoot, cleanName))
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-primary/20 bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Cloud aria-hidden className="size-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">iCloud sync</h2>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              Recommended
            </span>
          </div>
          <p className="text-xs text-text-muted">
            {graphs.length > 0
              ? 'We found notes in iCloud Drive. Continue with one, or start fresh.'
              : 'Recommended for most people. Your notes sync through iCloud Drive and stay available offline.'}
          </p>
        </div>
      </div>

      {pending ? (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Spinner />
          Checking iCloud Drive…
        </div>
      ) : (
        <>
          {graphs.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {graphs.map((root) => (
                <li key={root}>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start text-left"
                    onClick={() => onOpen(root)}
                    disabled={busy}
                  >
                    {pendingChoice === root ? (
                      <Spinner />
                    ) : (
                      <FolderOpen aria-hidden strokeWidth={1.75} />
                    )}
                    <span className="truncate">Continue with {graphNameFromRoot(root, root)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Button
              type="button"
              className="w-full justify-start text-left"
              onClick={createDefault}
              disabled={busy || documentsRoot === null}
            >
              {pendingChoice === 'icloud-create' ? (
                <Spinner />
              ) : (
                <Cloud aria-hidden strokeWidth={1.75} />
              )}
              {pendingChoice === 'icloud-create' ? 'Setting up…' : 'Continue with iCloud'}
            </Button>
          )}

          {graphs.length > 0 ? (
            <div className="space-y-2">
              <MobileDivider>Start fresh</MobileDivider>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={nameId} className="text-xs font-medium text-text-secondary">
                  Name
                </label>
                <div className="flex gap-2">
                  <Input
                    id={nameId}
                    value={name}
                    placeholder="Personal notes"
                    enterKeyHint="go"
                    onChange={(event) => setTypedName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        create()
                      }
                    }}
                    aria-invalid={nameTaken}
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    className="shrink-0"
                    onClick={create}
                    disabled={busy || cleanName === null || nameTaken}
                  >
                    {pendingChoice === 'icloud-create' ? (
                      <Spinner />
                    ) : (
                      <Plus aria-hidden strokeWidth={1.75} />
                    )}
                    {pendingChoice === 'icloud-create' ? 'Setting up…' : 'Create in iCloud'}
                  </Button>
                </div>
              </div>
              {nameTaken ? (
                <p className="text-xs text-destructive">
                  That name already exists in iCloud Drive.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function MobileDivider({ children }: { children: string }): ReactElement {
  return (
    <div className="flex items-center gap-3 py-1">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium text-text-muted">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}
