import { useCallback, useEffect, useRef } from 'react'
import type { OpenTask } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Mirror the text of a task editor into the task commands: the returned
 * function takes each change of the editor. The typed text is saved when the
 * component stays unmounted.
 */
export function useTaskDraft(task: OpenTask): (markdown: string) => void {
  const { commands } = useCoreServices().tasks
  const taskRef = useRef(task)
  useEffect(() => {
    taskRef.current = task
  })
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // StrictMode unmounts and remounts a component that is still showing.
      queueMicrotask(() => {
        if (!mountedRef.current) {
          void commands.commit(taskRef.current)
        }
      })
    }
  }, [commands])
  return useCallback((markdown: string) => commands.setDraft(taskRef.current, markdown), [commands])
}
