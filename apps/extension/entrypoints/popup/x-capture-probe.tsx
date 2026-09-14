import { useState, type FormEvent, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import {
  captureProbeResponseSchema,
  postIdSchema,
  type CaptureProbeReport,
} from '@/lib/x-capture-messages'

interface XCaptureProbeProps {
  initialPostId: string
}

type ProbeState =
  | { phase: 'idle' | 'pending' }
  | { phase: 'failed'; reason: string }
  | { phase: 'complete'; report: CaptureProbeReport }

function failureMessage(reason: string): string {
  switch (reason) {
    case 'not-observed':
    case 'lookup-failed':
    case 'lookup-unavailable':
      return 'Refresh the X page, expand the post, then reopen this panel and retry.'
    case 'page-changed':
    case 'wrong-permalink':
      return 'The target changed. Open the matching post permalink and retry.'
    case 'probe-already-running':
      return 'A probe is still reading this tab. Wait for it to finish before retrying.'
    default:
      return 'Could not read this post. Check the permalink and reload the extension and X page.'
  }
}

/** Development-only diagnostics for an observed X post and its media bytes. */
export function XCaptureProbe({ initialPostId }: XCaptureProbeProps): ReactElement {
  const [postId, setPostId] = useState(initialPostId)
  const [state, setState] = useState<ProbeState>({ phase: 'idle' })
  const pending = state.phase === 'pending'

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (pending) return
    const parsed = postIdSchema.safeParse(postId.trim())
    if (!parsed.success) {
      setState({ phase: 'failed', reason: 'invalid-post-id' })
      return
    }
    setState({ phase: 'pending' })
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (tab?.id == null) throw new Error('no-active-tab')
      const response = captureProbeResponseSchema.safeParse(
        await browser.runtime.sendMessage({
          type: 'x-capture:probe',
          tabId: tab.id,
          postId: parsed.data,
        }),
      )
      if (!response.success) throw new Error('invalid-probe-response')
      if (!response.data.ok) throw new Error(response.data.reason)
      setState({ phase: 'complete', report: response.data.report })
    } catch (error) {
      setState({ phase: 'failed', reason: error instanceof Error ? error.message : 'probe-failed' })
    }
  }

  return (
    <section className="border-t border-border p-3" aria-label="X capture diagnostics">
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">X capture probe (development)</h2>
        <p className="text-xs text-text-muted">
          Refresh the permalink first. Reads and discards media bytes; nothing is saved to your
          graph. Keep this popup open while reading.
        </p>
        <label htmlFor="x-probe-post-id" className="text-xs text-text-secondary">
          Post ID
        </label>
        <input
          id="x-probe-post-id"
          value={postId}
          onChange={(event) => setPostId(event.target.value)}
          inputMode="numeric"
          disabled={pending}
          className="rounded-md border border-border bg-input-bg px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-focus-ring"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-hover disabled:opacity-60"
        >
          {pending ? 'Reading post and media…' : 'Run probe'}
        </button>
      </form>
      {state.phase === 'failed' ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {failureMessage(state.reason)} ({state.reason})
        </p>
      ) : null}
      {state.phase === 'complete' ? (
        <div className="mt-3 flex flex-col gap-2 text-xs" aria-live="polite">
          <p>Probe finished. Media read failures are listed below.</p>
          <p>
            Videos/GIFs: {state.report.counts.videoCount}; MP4 available:{' '}
            {state.report.counts.mp4Available}; HLS-only: {state.report.counts.hlsOnly}; no source:{' '}
            {state.report.counts.noSource}.
          </p>
          {(
            [
              ['Post', state.report.post],
              ['Quote', state.report.post.quote],
            ] as const
          ).map(([label, post]) =>
            post ? (
              <div key={label}>
                <p className="font-medium">
                  {label}: @{post.author.handle}
                </p>
                {post.truncated ? (
                  <p className="text-destructive">Truncated: expand the post and retry.</p>
                ) : null}
                <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                  {post.body.map((segment) => segment.text).join('') || '(No text)'}
                </p>
              </div>
            ) : null,
          )}
          <ul className="flex flex-col gap-1">
            {state.report.results.map((result) => (
              <li key={result.slot} className="break-words">
                {result.slot}:{' '}
                {result.status === 'read'
                  ? `${result.bytes} bytes (${result.mime})`
                  : `${result.status}: ${result.reason}`}
                {result.unavailable ? ' (source marked unavailable)' : ''}
              </li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer text-text-muted">
              Byte signatures and document token
            </summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(
                {
                  documentToken: state.report.documentToken,
                  results: state.report.results,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      ) : null}
    </section>
  )
}
