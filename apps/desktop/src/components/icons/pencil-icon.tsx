import type { ReactElement } from 'react'

interface PencilIconProps {
  className?: string
}

/** V1's "Daily notes" pencil glyph — a 24×24 currentColor fill. */
export function PencilIcon({ className }: PencilIconProps): ReactElement {
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
        d="M13.3393 5.97122C14.6343 4.67626 16.7338 4.67626 18.0288 5.97122C19.3238 7.26618 19.3238 9.36572 18.0288 10.6607L11.6333 17.0562C11.5491 17.1403 11.4462 17.2033 11.3329 17.2397L5.97996 18.9639C5.71217 19.0501 5.41863 18.9793 5.21969 18.7803C5.02075 18.5814 4.94988 18.2879 5.03614 18.0201L6.76027 12.6671C6.79676 12.5539 6.85968 12.4509 6.94383 12.3667L13.3393 5.97122ZM16.9681 7.03188C16.259 6.32271 15.1092 6.32271 14.4 7.03188L8.13253 13.2994L6.91234 17.0877L10.7007 15.8675L16.9681 9.60001C17.6773 8.89084 17.6773 7.74105 16.9681 7.03188Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M13.3393 5.97122C14.6343 4.67626 16.7338 4.67626 18.0288 5.97122C19.3238 7.26618 19.3238 9.36572 18.0288 10.6607C17.7359 10.9536 17.261 10.9536 16.9681 10.6607L13.3393 7.03188C13.0464 6.73898 13.0465 6.26411 13.3393 5.97122Z"
        fill="currentColor"
      />
    </svg>
  )
}
