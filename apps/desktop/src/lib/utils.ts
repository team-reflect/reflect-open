import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names, de-duplicating conflicting Tailwind utilities
 * (the standard shadcn `cn` helper). Last-write-wins for clashing utilities.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
