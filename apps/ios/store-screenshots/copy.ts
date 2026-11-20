// The captions of the screenshots, in App Store order. `accent` is part of
// `title` and shows in the accent color.

export const SCREENS = [
  {
    id: 'daily',
    title: 'Your day, on one page.',
    accent: 'one page',
    subtitle: 'Daily notes for tasks, meetings, and ideas.',
  },
  {
    id: 'note',
    title: 'Link ideas, not folders.',
    accent: 'Link ideas',
    subtitle: 'Backlinks show every note that mentions a person or project.',
  },
  {
    id: 'search',
    title: 'Find anything, instantly.',
    accent: 'instantly',
    subtitle: 'Fast full-text search across every note.',
  },
  {
    id: 'chat',
    title: 'Get answers from AI.',
    accent: 'answers',
    subtitle: 'AI answers from your own notes, using your own API key.',
  },
  {
    id: 'tasks',
    title: 'Every task, in one place.',
    accent: 'Every task',
    subtitle: 'Tasks from all your notes, grouped by date.',
  },
] as const

export type Screen = (typeof SCREENS)[number]
