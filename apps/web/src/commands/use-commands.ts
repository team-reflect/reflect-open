import { useEffect, useRef } from 'react'
import type { AppCommandId, CommandHandler } from '@reflect/app'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Command handlers by id. An `undefined` handler registers nothing, so a
 * caller can offer a command only in some states (a note on screen, the chat
 * route).
 */
export type CommandHandlers = Partial<Record<AppCommandId, CommandHandler | undefined>>

/**
 * Register `handlers` while the calling component is mounted. The latest
 * render's handlers run, so they may close over render values.
 */
export function useCommands(handlers: CommandHandlers): void {
  const { commands } = useAppServices()
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })
  // Re-register only when the set of handled ids changes.
  const ids = Object.keys(handlers)
    .filter((id) => handlers[id as AppCommandId] !== undefined)
    .join(' ')
  useEffect(() => {
    if (ids === '') {
      return
    }
    const controller = new AbortController()
    for (const id of ids.split(' ') as AppCommandId[]) {
      commands.handle(id, () => handlersRef.current[id]?.(), controller.signal)
    }
    return () => controller.abort()
  }, [commands, ids])
}

export function useCommandHandler_WIP(
  id: AppCommandId,
  handler: CommandHandler | undefined | null,
): void {
  const { commands } = useAppServices()

  useEffect(() => {
    const controller = new AbortController()
    if (!handler) {
      return
    }
    commands.handle(id, handler, controller.signal)
    return () => controller.abort()
  }, [id, handler, commands])
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
