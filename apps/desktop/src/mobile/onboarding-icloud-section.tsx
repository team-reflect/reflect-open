import { useId, useState, type ReactElement } from 'react'
import { Cloud, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cleanGraphName, graphNameFromRoot, graphRootForName, isGraphNameTaken } from '@/lib/graph-names'
import { OnboardingIcloudHeader } from '@/mobile/onboarding-icloud-header'

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

  // Fresh iCloud setup still needs a user-editable graph name; keep the
  // friendly default, but only leave the field blank when creating alongside
  // existing iCloud notes where "Notes" would usually collide.
  const name = typedName ?? (graphs.length > 0 ? '' : DEFAULT_ICLOUD_NOTES_NAME)
  const cleanName = cleanGraphName(name)
  const nameTaken = cleanName !== null && isGraphNameTaken(cleanName, graphs)

  function create(): void {
    if (documentsRoot === null || cleanName === null || nameTaken) {
      return
    }
    onCreate(graphRootForName(documentsRoot, cleanName))
  }

  const description =
    graphs.length > 0
      ? 'We found notes in iCloud Drive. Continue with one, or start fresh.'
      : 'Recommended for most people. Your notes sync through iCloud Drive and stay available offline.'

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-primary/20 bg-surface p-4">
      <OnboardingIcloudHeader description={description} />

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
          ) : null}

          <div className="space-y-2">
            {graphs.length > 0 ? <MobileDivider>Start fresh</MobileDivider> : null}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={nameId} className="text-xs font-medium text-text-secondary">
                Graph name
              </label>
              <Input
                id={nameId}
                value={name}
                placeholder={graphs.length > 0 ? 'Personal notes' : undefined}
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
            </div>
            {nameTaken ? (
              <p className="text-xs text-destructive">
                That name already exists in iCloud Drive.
              </p>
            ) : null}
            <Button
              type="button"
              className="w-full justify-start text-left"
              onClick={create}
              disabled={busy || cleanName === null || nameTaken || documentsRoot === null}
            >
              {pendingChoice === 'icloud-create' ? (
                <Spinner />
              ) : (
                <Cloud aria-hidden strokeWidth={1.75} />
              )}
              {pendingChoice === 'icloud-create' ? 'Setting up…' : 'Setup graph'}
            </Button>
          </div>
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
