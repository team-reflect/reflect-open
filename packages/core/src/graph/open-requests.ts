import { z } from 'zod'
import { call } from '../ipc/invoke'
import { getBridge, type Unlisten } from '../ipc/bridge'

/** Event emitted by the native shell when a Dock/Finder graph-open request is queued. */
export const GRAPH_OPEN_REQUESTED_EVENT = 'graph:open-requested'

const graphOpenRequestedPayloadSchema = z.null()

/** Pop the oldest native graph-open request, or `null` when none is queued. */
export async function takeGraphOpenRequest(): Promise<string | null> {
  return call('graph_open_request_take', {}, z.string().nullable())
}

/** Subscribe to native graph-open request notifications. */
export function subscribeGraphOpenRequested(handler: () => void): Promise<Unlisten> {
  return getBridge().listen(GRAPH_OPEN_REQUESTED_EVENT, (payload) => {
    const parsed = graphOpenRequestedPayloadSchema.safeParse(payload)
    if (parsed.success) {
      handler()
    } else {
      console.error('invalid graph:open-requested payload:', parsed.error)
    }
  })
}
