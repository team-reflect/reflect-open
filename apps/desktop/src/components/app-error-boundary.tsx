import { useState, type ReactElement, type ReactNode } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { CRASH_FALLBACK_DESIGNS } from '@/components/crash-fallback-designs'

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

function reload(): void {
  window.location.reload()
}

function CrashFallback({ error }: FallbackProps): ReactElement {
  const [designIndex, setDesignIndex] = useState(0)
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? null) : null
  const design = CRASH_FALLBACK_DESIGNS[designIndex] ?? CRASH_FALLBACK_DESIGNS[0]!
  return (
    <>
      <design.Render message={message} stack={stack} reload={reload} />
      {/* Temporary design picker: delete along with the losing designs once
          one is chosen. */}
      <select
        aria-label="Crash screen design"
        value={designIndex}
        onChange={(event) => {
          setDesignIndex(Number(event.target.value))
        }}
        className="fixed right-3 bottom-3 z-50 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-secondary"
      >
        {CRASH_FALLBACK_DESIGNS.map((candidate, index) => (
          <option key={candidate.name} value={index}>
            {`${index + 1} · ${candidate.name}`}
          </option>
        ))}
      </select>
    </>
  )
}
