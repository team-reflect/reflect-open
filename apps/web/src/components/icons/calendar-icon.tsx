import type { ReactElement } from 'react'

interface CalendarIconProps {
  className?: string
}

/** V1's calendar glyph (the "Jump to Today" button) — 24×24 currentColor. */
export function CalendarIcon({ className }: CalendarIconProps): ReactElement {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.75 6.5C7.50736 6.5 6.5 7.50736 6.5 8.75V15.25C6.5 16.4926 7.50736 17.5 8.75 17.5H15.25C16.4926 17.5 17.5 16.4926 17.5 15.25V8.75C17.5 7.50736 16.4926 6.5 15.25 6.5H8.75ZM5 8.75C5 6.67893 6.67893 5 8.75 5H15.25C17.3211 5 19 6.67893 19 8.75V15.25C19 17.3211 17.3211 19 15.25 19H8.75C6.67893 19 5 17.3211 5 15.25V8.75Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 12.246C9.00002 11.8318 9.33581 11.4961 9.75003 11.4961L10.25 11.4961C10.6642 11.4961 11 11.8319 11 12.2461C11 12.6603 10.6642 12.9961 10.25 12.9961L9.74997 12.9961C9.33576 12.9961 8.99998 12.6603 9 12.246Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 8.75C5 6.67893 6.67893 5 8.75 5H15.25C17.3211 5 19 6.67893 19 8.75V9.25C19 9.66421 18.6642 10 18.25 10H5.75C5.33579 10 5 9.66421 5 9.25V8.75Z"
        fill="currentColor"
      />
    </svg>
  )
}
