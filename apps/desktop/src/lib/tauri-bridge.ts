import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { setBridge, type IpcBridge } from '@reflect/core'

/**
 * Adapts Tauri's IPC primitives to the `@reflect/core` bridge contract. This is
 * the only place the desktop app touches `@tauri-apps/api` for command/event
 * transport — everything else goes through the typed `@reflect/core` bindings.
 */
export const tauriBridge: IpcBridge = {
  invoke: (command, args) => invoke(command, args),
  // A Uint8Array payload rides Tauri's raw-body IPC path (no JSON, no
  // base64); metadata travels in headers since a raw body has no args.
  invokeBinary: (command, body, headers) => invoke(command, body, { headers }),
  listen: async (event, handler) => {
    const unlisten = await listen(event, (incoming) => handler(incoming.payload))
    return () => {
      // Tauri types unlisten() as `() => void`, but at runtime it is async and
      // can reject: its injected cleanup script reads `listeners[eventId].handlerId`
      // unguarded, so tearing a listener down around the time its registration
      // script lands throws "undefined is not an object" (tauri-apps/tauri#13746,
      // still unguarded on Tauri's `dev`). Subscriptions that resolve after their
      // owner has already unmounted hit this — see use-file-changes.ts. The
      // teardown is benign, so swallow the rejection instead of letting it surface
      // as an unhandled promise rejection.
      void Promise.resolve(unlisten() as void | Promise<void>).catch(() => {})
    }
  },
}

/**
 * Install the Tauri bridge when running inside a Tauri webview. Plain-browser
 * dev (`pnpm dev` without the shell) installs nothing; `hasBridge()` then gates
 * native-only features like the file watcher and the recents store.
 */
export function installTauriBridge(): void {
  if (isTauri()) {
    setBridge(tauriBridge)
  }
}
