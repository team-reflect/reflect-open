import { addDaysToIsoDate } from '@reflect/utils'

export interface TaskDatePreset {
  title: string
  menuTitle: string
  date: string
}

export function getTaskDatePresets(today: string): TaskDatePreset[] {
  return [
    { title: 'Today', menuTitle: 'Today', date: today },
    { title: 'Tomorrow', menuTitle: 'Tomorrow', date: addDaysToIsoDate(today, 1) },
    { title: 'Next week', menuTitle: 'Next Week', date: addDaysToIsoDate(today, 7) },
  ]
}
