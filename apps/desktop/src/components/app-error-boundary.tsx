import type { ReactElement, ReactNode } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { Button } from '@/components/ui/button'

/**
 * Catches render-phase crashes on both surfaces. Without a boundary React
 * unmounts the whole root, which leaves a blank window that only an app
 * relaunch recovers (issue #1130); on mobile an unmounted tree is also
 * indistinguishable from a hang, since WKWebView's console is out of reach.
 * Sentry still records the error: with a boundary present it arrives through
 * the root's `onCaughtError` handler instead of `onUncaughtError` (both are
 * wired in `main.tsx`). Ten quick taps on the settings version field crash
 * the tree on purpose to drill this screen (`useCrashTestTap`).
 */
export function AppErrorBoundary({ children }: { children: ReactNode }): ReactElement {
  return (
    <ErrorBoundary
      FallbackComponent={CrashFallback}
      onError={(error, info) => {
        console.error('render crash:', error, info.componentStack)
      }}
    >
      {children}
    </ErrorBoundary>
  )
}

function CrashFallback({ error }: FallbackProps): ReactElement {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-sm font-medium">Something broke</p>
      <p className="text-sm text-text-muted">{message}</p>
      <Button
        variant="outline"
        className="mt-2"
        onClick={() => {
          window.location.reload()
        }}
      >
        Reload
      </Button>
    </div>
  )
}
