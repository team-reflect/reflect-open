import type { ReactElement } from 'react'
import { Bug, Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Candidate designs for the crash screen, switchable from the temporary
 * picker in `AppErrorBoundary`. One will be chosen and the rest deleted.
 */

export interface CrashFallbackDesignProps {
  message: string
  stack: string | null
  reload: () => void
}

export interface CrashFallbackDesign {
  name: string
  Render: (props: CrashFallbackDesignProps) => ReactElement
}

function Minimal({ message, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="text-sm text-text-muted">{message}</p>
      <Button variant="outline" className="mt-2" onClick={reload}>
        Reload
      </Button>
    </div>
  )
}

function Card({ message, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen items-center justify-center px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-border bg-surface p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <TriangleAlert className="size-6 text-destructive" />
        </div>
        <p className="text-base font-semibold">Something went wrong</p>
        <p className="text-sm text-text-muted">{message}</p>
        <Button className="mt-2 w-full" onClick={reload}>
          Reload
        </Button>
      </div>
    </div>
  )
}

function Console({ message, stack, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-4 px-6">
      <p className="text-sm font-medium">Something went wrong</p>
      <pre className="max-h-64 w-full max-w-lg overflow-auto rounded-lg bg-muted p-4 text-left font-mono text-xs text-text-secondary">
        {stack ?? message}
      </pre>
      <Button variant="outline" onClick={reload}>
        <RefreshCw /> Reload
      </Button>
    </div>
  )
}

function Playful({ message, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-3 px-8 text-center">
      <span aria-hidden className="text-5xl">
        💥
      </span>
      <p className="text-lg font-semibold">Something went wrong</p>
      <p className="max-w-sm text-sm text-text-muted">
        The app tripped over itself. A reload usually fixes it.
      </p>
      <p className="max-w-sm text-xs text-text-muted">{message}</p>
      <Button className="mt-1" onClick={reload}>
        Reload
      </Button>
    </div>
  )
}

function Banner({ message, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="h-dvh w-screen">
      <div className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-4 py-3">
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">Something went wrong</p>
          <p className="truncate text-xs text-text-muted">{message}</p>
        </div>
        <Button size="sm" variant="destructive" onClick={reload}>
          Reload
        </Button>
      </div>
    </div>
  )
}

function Split({ message, stack, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen flex-col justify-center gap-8 px-8 py-12 md:flex-row md:items-center md:gap-12">
      <div className="flex max-w-xs flex-col items-start gap-3">
        <p className="text-2xl font-semibold">Something went wrong</p>
        <p className="text-sm text-text-muted">
          The window hit an error it could not recover from in place.
        </p>
        <Button onClick={reload}>Reload</Button>
      </div>
      <pre className="max-h-72 w-full max-w-md overflow-auto rounded-lg border border-border bg-surface p-4 font-mono text-xs text-text-secondary">
        {stack ?? message}
      </pre>
    </div>
  )
}

function Dialog({ message, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen items-center justify-center bg-black/20 px-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-popover p-4 text-sm ring-1 ring-foreground/10">
        <p className="font-heading text-base font-medium">Something went wrong</p>
        <p className="text-text-muted">{message}</p>
        <div className="flex justify-end">
          <Button onClick={reload}>Reload</Button>
        </div>
      </div>
    </div>
  )
}

function Diagnostic({ message, stack, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="max-w-md text-sm text-text-muted">{message}</p>
      <details className="w-full max-w-md text-left">
        <summary className="cursor-default text-xs text-text-muted">Technical details</summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs text-text-secondary">
          {stack ?? message}
        </pre>
      </details>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(stack ?? message)
          }}
        >
          <Copy /> Copy error
        </Button>
        <Button onClick={reload}>
          <RefreshCw /> Reload
        </Button>
      </div>
    </div>
  )
}

function Branded({ message, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 bg-gradient-to-b from-accent-soft/60 to-transparent px-8 text-center">
      <p className="text-xs font-medium tracking-widest text-text-muted uppercase">Reflect Open</p>
      <p className="mt-2 text-xl font-semibold">Something went wrong</p>
      <p className="max-w-sm text-sm text-text-muted">{message}</p>
      <Button variant="outline" className="mt-3" onClick={reload}>
        Reload
      </Button>
    </div>
  )
}

function OneLiner({ message, reload }: CrashFallbackDesignProps): ReactElement {
  return (
    <div className="flex h-dvh w-screen flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex items-center gap-2 rounded-full border border-border bg-surface py-1.5 pr-1.5 pl-3">
        <Bug className="size-3.5 text-text-muted" />
        <span className="text-sm">Something went wrong</span>
        <Button size="sm" onClick={reload}>
          Reload
        </Button>
      </div>
      <p className="max-w-sm text-xs text-text-muted">{message}</p>
    </div>
  )
}

export const CRASH_FALLBACK_DESIGNS: CrashFallbackDesign[] = [
  { name: 'Minimal', Render: Minimal },
  { name: 'Card', Render: Card },
  { name: 'Console', Render: Console },
  { name: 'Playful', Render: Playful },
  { name: 'Banner', Render: Banner },
  { name: 'Split', Render: Split },
  { name: 'Dialog', Render: Dialog },
  { name: 'Diagnostic', Render: Diagnostic },
  { name: 'Branded', Render: Branded },
  { name: 'One-liner', Render: OneLiner },
]
