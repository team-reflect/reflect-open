/**
 * The pluggable transport between `@reflect/core` and its host backend.
 *
 * `@reflect/core` is platform-agnostic: nothing in this package imports
 * `@tauri-apps/*`. A host installs a bridge at startup — the desktop app
 * adapts Tauri's `invoke`/`listen` (see `apps/desktop/src/lib/tauri-bridge.ts`),
 * plain-browser dev installs the in-memory dev bridge
 * (`apps/desktop/src/dev/`), and tests install fakes via {@link setBridge}.
 * A bridge answering commands does NOT imply a native shell: gates that need
 * real plugins, custom URL schemes, or OS windows use the desktop app's
 * `isNativeShell()` instead of {@link hasBridge}.
 */

/** Tears down a subscription created by {@link IpcBridge.listen}. */
export type Unlisten = () => void

/** The two native primitives `@reflect/core` needs from its host. */
export interface IpcBridge {
  /** Invoke a native command, resolving with its raw (untyped) response. */
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
  /** Subscribe to a native event stream, resolving with an unlisten function. */
  listen: (event: string, handler: (payload: unknown) => void) => Promise<Unlisten>
  /**
   * Invoke a native command with a **raw binary body** instead of JSON args —
   * asset bytes cross the IPC without base64 inflation. Since a raw body
   * carries no args, per-call metadata travels in `headers`. Optional: hosts
   * without a binary transport simply don't stream assets; `callBinary`
   * throws loudly rather than degrading.
   */
  invokeBinary?: (
    command: string,
    body: Uint8Array,
    headers: Record<string, string>,
  ) => Promise<unknown>
  /**
   * Attach a handler to a plugin's event stream, Tauri's
   * `addPluginListener` channel (`keyboardChange`, `recordingLevel`, ...),
   * which is distinct from the global event bus behind {@link listen}.
   */
  listenPlugin?: (
    plugin: string,
    event: string,
    handler: (payload: unknown) => void,
  ) => Promise<void>
}

let activeBridge: IpcBridge | null = null

/** Notified on every {@link setBridge}, so UI layers can re-read {@link hasBridge}. */
const changeListeners = new Set<() => void>()

/**
 * Install the process-wide bridge (or remove it with `null`), then notify
 * {@link subscribeBridgeChanges} subscribers. The Tauri bridge installs
 * before the first render; the browser dev bridge installs asynchronously
 * after it, which is why UI gates must subscribe rather than sample once.
 */
export function setBridge(bridge: IpcBridge | null): void {
  activeBridge = bridge
  for (const listener of changeListeners) {
    listener()
  }
}

/**
 * Subscribe to bridge installs/removals; returns the unsubscribe function.
 * The `useSyncExternalStore`-shaped companion to {@link hasBridge} — the
 * desktop app's `useBridgeReady()` hook builds on this pair so React gates
 * re-render when the (possibly async) install lands.
 */
export function subscribeBridgeChanges(listener: () => void): Unlisten {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/**
 * True when a bridge is installed — i.e. IPC commands can be answered. True
 * in the real shell AND in browser dev once the in-memory dev bridge
 * installs, so this means "data is reachable", never "a native shell
 * exists" (that question is the desktop app's `isNativeShell()`). React
 * render scope must not sample this directly (the answer would go stale
 * when the dev bridge installs asynchronously) — components use
 * `useBridgeReady()`, which subscribes via {@link subscribeBridgeChanges}.
 * Imperative code (event handlers, controllers) keeps calling this at its
 * own call time.
 */
export function hasBridge(): boolean {
  return activeBridge !== null
}

/**
 * True when the installed bridge has the raw-binary transport ({@link
 * IpcBridge.invokeBinary}) — the real shell has it, the browser-dev
 * in-memory bridge does not. Callers use this to choose streamed binary
 * asset IO over the base64 JSON fallback.
 */
export function hasBinaryIpc(): boolean {
  return activeBridge !== null && activeBridge.invokeBinary !== undefined
}

/** The installed bridge; throws when called before {@link setBridge}. */
export function getBridge(): IpcBridge {
  if (activeBridge === null) {
    throw new Error(
      'No IPC bridge is installed. Call setBridge() at startup — the desktop app installs the Tauri bridge in main.tsx; tests install a fake.',
    )
  }
  return activeBridge
}
