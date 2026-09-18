import { addPluginListener, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { IpcBridge } from '@reflect/core'

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
    // Listen on this window's label instead of Tauri's default `Any` target.
    // An `Any` listener is exempt from the `emit_to` filter, so every note
    // window received the `window:navigate` that the shell addressed to one of
    // them, and all of them re-navigated. A label target still receives
    // `app.emit` broadcasts. Step by step (tauri 2.11.5, @tauri-apps/api 2.11.1):
    //
    // 1. `listen` with no `target` registers `{ kind: 'Any' }`, and a string
    //    target registers `{ kind: 'AnyLabel', label }`:
    //    https://github.com/tauri-apps/tauri/blob/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a/packages/api/src/event.ts#L120-L123
    // 2. The shell sends `window:navigate` with `emit_to(label, ...)`:
    //    https://github.com/team-reflect/reflect-open/blob/bce502838c62a2b540a0847e86b155913a30c51d/apps/desktop/src-tauri/src/windows.rs#L319
    //    A `&str` target converts to `AnyLabel`:
    //    https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri/src/event/mod.rs#L97-L103
    //    and `emit_to` turns it into a filter matching only same-label listeners:
    //    https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri/src/manager/mod.rs#L604-L637
    // 3. `emit_filter` hands that filter to `emit_js_filter`:
    //    https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri/src/manager/mod.rs#L577-L581
    //    JS listeners are then selected through `match_any_or_filter`, which
    //    accepts an `Any` listener before it consults the filter:
    //    https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri/src/event/listener.rs#L284-L288
    //    https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri/src/event/listener.rs#L306-L311
    // 4. `emit` calls `emit_js`, which passes no filter, so `unwrap_or(true)`
    //    in (3) delivers broadcasts to label-targeted listeners as well:
    //    https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri/src/manager/mod.rs#L548
    //    https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri/src/event/listener.rs#L296-L302
    const unlisten = await listen(event, (incoming) => handler(incoming.payload), {
      target: getCurrentWebviewWindow().label,
    })
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
  listenPlugin: async (plugin, event, handler) => {
    await addPluginListener<unknown>(plugin, event, handler)
  },
}
