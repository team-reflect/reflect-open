import { useEffect, useEffectEvent } from 'react'
import type { AppCommandId, CommandHandler } from '@reflect/app'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Register `handler` for `id` while the calling component is mounted. An
 * `undefined` handler registers nothing, so a caller can offer a command only
 * in some states (a note on screen, the chat route). The latest render's
 * handler runs, so it may close over render values.
 */
export function useCommandHandler(id: AppCommandId, handler: CommandHandler | undefined): void {
  const { commands } = useAppServices()
  const run = useEffectEvent(() => handler?.())
  const enabled = handler !== undefined
  useEffect(() => {
    if (!enabled) {
      return
    }
    const controller = new AbortController()
    commands.handle(id, run, controller.signal)
    return () => controller.abort()
  }, [commands, id, enabled])
}

/**
 * Stop keys and menu items from running any command except `allow` while
 * `active` is true. A modal screen blocks while it is open.
 */
export function useCommandBlock(active: boolean, allow: readonly AppCommandId[]): void {
  const { commands } = useAppServices()
  useEffect(() => {
    if (!active) {
      return
    }
    const controller = new AbortController()
    commands.block(allow, controller.signal)
    return () => controller.abort()
  }, [commands, active, allow])
}
