/**
 * The demo graph the dev bridge boots with: enough daily notes, tagged notes,
 * wiki links, pins, tasks, and a private note that every mobile surface — the
 * Daily carousel, the All tab with its filter badges, drawers, and search —
 * renders with believable data. Dates are computed relative to "today" so the
 * daily stream always lands on the current week.
 */

/** Local-time `YYYY-MM-DD` for `offsetDays` before today. */
function isoDay(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() - offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Frontmatter block for a seeded note. Ids are fixed Crockford-base32 ULIDs. */
function frontmatter(entries: Record<string, string>): string {
  const lines = Object.entries(entries).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n`
}

/** The demo graph: graph-relative path → markdown source. */
export function seedGraphFiles(): Record<string, string> {
  const today = isoDay(0)
  const yesterday = isoDay(1)
  const nextWeek = isoDay(-7)

  return {
    [`daily/${today}.md`]: [
      `- Morning review with [[Sarah Chen]] about the [[Reflect V2]] launch`,
      `- [ ] Ship the mobile filter badges [[${today}]]`,
      `- [ ] Reply to the beta feedback thread`,
      `- Started reading [[Atomic Habits]] on the train #book`,
      ``,
    ].join('\n'),
    [`daily/${yesterday}.md`]: [
      `- Pairing session on the day carousel swipe physics`,
      `- [x] Fix the week-strip echo guard`,
      `- Lunch with [[James Clear]] — talked habit loops #person`,
      ``,
    ].join('\n'),
    [`daily/${isoDay(2)}.md`]: [
      `- Sketched the [[Quarterly Goals]] doc`,
      `- [ ] Book flights for the offsite [[${nextWeek}]]`,
      ``,
    ].join('\n'),
    [`daily/${isoDay(4)}.md`]: [
      `- Deep-work day on sync conflict handling`,
      `- Saved [Local-first software](https://www.inkandswitch.com/local-first/) #link`,
      ``,
    ].join('\n'),
    [`daily/${isoDay(7)}.md`]: [
      `- Weekly planning: reviewed [[Reading List]]`,
      `- [x] Cut the 0.2 beta release`,
      ``,
    ].join('\n'),
    'notes/reflect-v2.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0a', pinned: '1' }),
      `# Reflect V2`,
      ``,
      `The offline-first rewrite. Markdown on disk, SQLite as a rebuildable`,
      `projection, sync over Git.`,
      ``,
      `- Owner: [[Sarah Chen]]`,
      `- [ ] Mobile parity pass [[${nextWeek}]]`,
      `- [x] Ship the All tab search`,
      ``,
    ].join('\n'),
    'notes/sarah-chen.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0b' }),
      `# Sarah Chen`,
      ``,
      `- Type: #person`,
      `- Engineering lead on [[Reflect V2]]`,
      `- Prefers async updates, Tuesday 1:1s`,
      ``,
    ].join('\n'),
    'notes/james-clear.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0c' }),
      `# James Clear`,
      ``,
      `- Type: #person`,
      `- Author of [[Atomic Habits]]`,
      ``,
    ].join('\n'),
    'notes/atomic-habits.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0d' }),
      `# Atomic Habits`,
      ``,
      `- Type: #book`,
      `- Author: [[James Clear]]`,
      ``,
      `Systems over goals. Make it obvious, attractive, easy, satisfying.`,
      ``,
    ].join('\n'),
    'notes/local-first-software.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0e' }),
      `# Local-first software`,
      ``,
      `- Type: #link`,
      `- URL: https://www.inkandswitch.com/local-first/`,
      ``,
      `Seven ideals for software that keeps data on the device and syncs`,
      `without a server owning it. Core inspiration for [[Reflect V2]].`,
      ``,
    ].join('\n'),
    'notes/reading-list.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0f' }),
      `# Reading List`,
      ``,
      `- [[Atomic Habits]] #book`,
      `- [[Local-first software]] #link`,
      `- How Buildings Learn #book`,
      ``,
    ].join('\n'),
    'notes/quarterly-goals.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0g' }),
      `# Quarterly Goals`,
      ``,
      `- [ ] Mobile app in TestFlight [[${nextWeek}]]`,
      `- [ ] 1k beta signups`,
      `- [x] Open-source the core`,
      ``,
    ].join('\n'),
    'notes/private-journal.md': [
      frontmatter({ id: '01hv3xq7c2dm8k4t9w5e6r1n0h', private: 'true' }),
      `# Private Journal`,
      ``,
      `Marked private — content here must never reach an external service.`,
      ``,
    ].join('\n'),
  }
}
