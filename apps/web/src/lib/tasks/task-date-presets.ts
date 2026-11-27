import { addDaysToIsoDate } from '@reflect/utils'

export interface TaskDatePreset {
  title: string
  date: string
}

export function getTaskDatePresets(today: string): TaskDatePreset[] {
  return [
    { title: 'Today', date: today },
    { title: 'Tomorrow', date: addDaysToIsoDate(today, 1) },
    { title: 'Next Week', date: addDaysToIsoDate(today, 7) },
  ]
}
