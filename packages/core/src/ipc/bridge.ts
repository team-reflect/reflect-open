/**
 * The pluggable transport between `@reflect/core` and the native shell.
 *
 * `@reflect/core` is platform-agnostic: nothing in this package imports
 * `@tauri-apps/*`. A host installs a bridge once at startup — the desktop app
 * adapts Tauri's `invoke`/`listen` (see `apps/desktop/src/lib/tauri-bridge.ts`),
 * tests install in-memory fakes via {@link setBridge}, and future hosts (the
 * CLI, Plan 14) either bring their own transport or skip IPC entirely and read
 * the index directly.
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
}

let activeBridge: IpcBridge | null = null

/**
 * Install the process-wide bridge (or remove it with `null`). Call once at
 * startup, before any command binding runs.
 */
export function setBridge(bridge: IpcBridge | null): void {
  activeBridge = bridge
}

/**
 * True when a bridge is installed — i.e. a native shell is reachable. UI code
 * uses this to gate native-only features (e.g. the file watcher) in
 * environments like browser dev where no shell exists.
 */
export function hasBridge(): boolean {
  return activeBridge !== null
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
