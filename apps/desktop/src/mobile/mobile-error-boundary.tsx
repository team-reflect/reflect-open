import { Component, type ErrorInfo, type ReactNode } from 'react'

interface MobileErrorBoundaryState {
  message: string | null
}

/**
 * Renders render-phase crashes as readable text instead of a white screen.
 * Mobile has no dev console in reach (WKWebView's console doesn't stream to
 * the dev log), so an unmounted tree is otherwise indistinguishable from a
 * hang — this boundary is the fail-loud surface of last resort.
 */
export class MobileErrorBoundary extends Component<
  { children: ReactNode },
  MobileErrorBoundaryState
> {
  override state: MobileErrorBoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): MobileErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('mobile render crash:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 px-8 text-center">
          <p className="text-sm font-medium">Something broke</p>
          <p className="text-sm text-text-muted">{this.state.message}</p>
        </div>
      )
    }
    return this.props.children
  }
}
