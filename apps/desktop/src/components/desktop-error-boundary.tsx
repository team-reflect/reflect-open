import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface DesktopErrorBoundaryState {
  message: string | null
}

/**
 * Catches render-phase crashes in the desktop tree. Without a boundary React
 * unmounts the whole root, which leaves a blank window that only an app
 * relaunch recovers (issue #1130). Sentry still records the error: with a
 * boundary present it arrives through the root's `onCaughtError` handler
 * instead of `onUncaughtError` (both are wired in `main.tsx`).
 */
export class DesktopErrorBoundary extends Component<
  { children: ReactNode },
  DesktopErrorBoundaryState
> {
  override state: DesktopErrorBoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): DesktopErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('desktop render crash:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 px-8 text-center">
          <p className="text-sm font-medium">Something broke</p>
          <p className="text-sm text-text-muted">{this.state.message}</p>
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
    return this.props.children
  }
}
