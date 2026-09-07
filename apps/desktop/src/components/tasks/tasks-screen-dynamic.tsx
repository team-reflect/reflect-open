import { lazy, Suspense, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const TasksScreen = lazy(() =>
  import('@/components/tasks/tasks-screen').then((module) => ({ default: module.TasksScreen })),
)

export function TasksScreenDynamic(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <TasksScreen />
    </Suspense>
  )
}
