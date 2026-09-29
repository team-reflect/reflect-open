import { z } from 'zod'
import { definePluginCommand } from './plugin.ts'

/**
 * Typed bindings for `plugins/tauri-plugin-web-auth`, the system web sign-in
 * session.
 */

export interface WebAuthOptions {
  /** The page to open, usually an OAuth authorize URL. */
  url: string
  /** The URL scheme (without `://`) whose navigation ends the session, e.g. `reflect`. */
  callbackScheme: string
  /** When true, the session shares no cookies or website data with the system browser. */
  ephemeral: boolean
}

// iOS omits `url` on cancel and the desktop stub sends `null`; accept both.
const startCommand = definePluginCommand<{ payload: WebAuthOptions }, { url?: string | null }>(
  'web-auth',
  'start',
  z.object({ url: z.string().nullish() }),
)

/**
 * Open `url` in the system web sign-in session and resolve the callback URL it
 * redirects to, or `null` when the user cancels.
 */
export async function startWebAuth(options: WebAuthOptions): Promise<string | null> {
  return (await startCommand({ payload: options })).url ?? null
}
