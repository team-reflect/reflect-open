import { addDaysToIsoDate } from '@reflect/utils'

export interface TaskDatePreset {
  id: 'today' | 'tomorrow' | 'next-week'
  label: string
  date: string
}

export function getTaskDatePresets(today: string): TaskDatePreset[] {
  return [
    { id: 'today', label: 'Today', date: today },
    { id: 'tomorrow', label: 'Tomorrow', date: addDaysToIsoDate(today, 1) },
    { id: 'next-week', label: 'Next week', date: addDaysToIsoDate(today, 7) },
  ]
}
