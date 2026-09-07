import { flushQueue } from '../flush'
import { saveCapture } from '../save-capture'
import type { PostCapturedMessage, PostCaptureResponse } from './messages'
import { readXCapturePreferences } from './preferences'
import { isPostSeen, markPostSeen } from './seen'

/** Injected dependencies of {@link handlePostCaptured}; production callers omit both. */
export interface HandlePostCapturedOptions {
  /** The queue flush to run after enqueueing; defaults to the background's `flushQueue`. */
  flush?: (() => Promise<unknown>) | undefined
  /** The capture clock (`capturedAt`); defaults to `new Date()`. */
  now?: (() => Date) | undefined
}

/** Reports in progress, one per post id — the second of two concurrent reports waits for the first. */
const inFlight = new Map<string, Promise<PostCaptureResponse>>()

/**
 * The background's half of a reported bookmark/like (Plan 25): apply the
 * preferences, consult the seen-set, and hand the post to the same queue
 * and flush every capture takes. Claims are serialized per post id: a
 * second report arriving while the first is still in flight (two tabs
 * showing the same post) waits, then finds the post seen. The post is
 * marked seen once it is queued; a rejected or failed enqueue leaves no mark,
 * so the next report retries.
 */
export async function handlePostCaptured(
  page: PostCapturedMessage['page'],
  options: HandlePostCapturedOptions = {},
): Promise<PostCaptureResponse> {
  const id = page.post.id
  const pending = inFlight.get(id)
  if (pending !== undefined) {
    await pending.catch(() => undefined)
    return await handlePostCaptured(page, options)
  }
  // The entry is removed on the work promise itself, before any waiter
  // resumes, so a waiter never re-finds the settled claim and spins.
  const work = claimAndEnqueue(page, options).finally(() => {
    inFlight.delete(id)
  })
  inFlight.set(id, work)
  return await work
}

async function claimAndEnqueue(
  page: PostCapturedMessage['page'],
  options: HandlePostCapturedOptions,
): Promise<PostCaptureResponse> {
  const preferences = await readXCapturePreferences()
  const trigger = page.post.trigger
  if (!preferences.bookmarks || (trigger === 'like' && !preferences.likes)) {
    return { saved: false, reason: 'disabled' }
  }
  if (await isPostSeen(page.post.id)) {
    return { saved: false, reason: 'seen' }
  }
  const outcome = await saveCapture(
    {
      url: page.url,
      title: page.title,
      post: page.post,
      id: crypto.randomUUID(),
      capturedAt: (options.now ?? (() => new Date()))(),
    },
    options.flush ?? flushQueue,
  )
  if (outcome.fate === 'rejected') {
    console.error(`post ${page.post.id} was rejected by the Reflect host`)
    return { saved: false, reason: 'rejected' }
  }
  await markPostSeen(page.post.id)
  return { saved: true, reason: 'queued' }
}
