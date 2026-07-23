import { useState, type ReactElement } from 'react'
import { errorMessage, retryNormalDiagnosticsStartup } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { useDiagnosticsShare } from '@/mobile/diagnostics-share'

/** Recovery surface shown before any settings, storage, or graph provider mounts. */
export function DiagnosticsRecovery(): ReactElement {
  const diagnostics = useDiagnosticsShare()
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  const retry = (): void => {
    setRetrying(true)
    setRetryError(null)
    void retryNormalDiagnosticsStartup().then(
      () => window.location.reload(),
      (cause: unknown) => {
        setRetrying(false)
        setRetryError(errorMessage(cause))
      },
    )
  }

  const shareOrPrepare = (): void => {
    if (diagnostics.ready) {
      diagnostics.share()
    } else {
      diagnostics.prepare()
    }
  }

  return (
    <main className="flex h-dvh w-screen items-center justify-center bg-background px-8 text-text">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <h1 className="text-lg font-semibold">Reflect stopped unexpectedly</h1>
        <p className="mt-2 text-sm leading-5 text-text-muted">
          The app’s web content stopped three times in a short period, so your notes haven’t been
          opened on this attempt.
        </p>
        <div className="mt-6 flex w-full flex-col gap-2">
          <Button className="h-11 w-full" disabled={retrying} onClick={retry}>
            {retrying ? 'Opening…' : 'Try opening notes'}
          </Button>
          <Button
            className="h-11 w-full"
            variant="outline"
            disabled={diagnostics.loading || diagnostics.sharing}
            onClick={shareOrPrepare}
          >
            {diagnostics.loading
              ? 'Preparing diagnostics…'
              : diagnostics.sharing
                ? 'Sharing…'
                : diagnostics.ready
                  ? 'Share diagnostics'
                  : 'Retry diagnostics'}
          </Button>
        </div>
        <p className="mt-4 text-xs leading-4 text-text-muted">
          Diagnostics contains only app/build details, startup stages, and termination markers—not
          notes, filenames, paths, settings, or general logs.
        </p>
        {retryError ?? diagnostics.error ? (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {retryError ?? diagnostics.error}
          </p>
        ) : null}
      </div>
    </main>
  )
}
