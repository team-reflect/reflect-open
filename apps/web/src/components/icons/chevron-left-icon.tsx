import type { ReactElement } from 'react'

interface ChevronLeftIconProps {
  className?: string
}

/** V1's left chevron — a 24×24 currentColor fill. */
export function ChevronLeftIcon({ className }: ChevronLeftIconProps): ReactElement {
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
        d="M14.7996 8.23966C15.0814 8.5432 15.0639 9.01775 14.7603 9.2996L11.8522 12L14.7603 14.7004C15.0639 14.9823 15.0814 15.4568 14.7996 15.7603C14.5177 16.0639 14.0432 16.0815 13.7397 15.7996L10.2397 12.5496C10.0868 12.4077 10 12.2086 10 12C10 11.7915 10.0868 11.5923 10.2397 11.4504L13.7397 8.20041C14.0432 7.91856 14.5177 7.93613 14.7996 8.23966Z"
        fill="currentColor"
      />
    </svg>
  )
}
