// The demo graph of the App Store screenshots, as a `UITestFixture` of the
// app (apps/ios/Sources/App/UITestFixture.swift).
//
// The simulator runs on the clock of the Mac, so every date comes from
// `today`, every weekday in the text is the weekday of a date in the graph,
// and every note changed before the 9:41 of the status bar.

/** A calendar day as `YYYY-MM-DD`, in local time. */
type Day = string

interface FixtureFile {
  contents: string
  /** Seconds since 1970. */
  modified?: number
}

const PROVIDER_ID = 'claude'

export const CHAT_QUESTION = 'What does Ava want for the rebrand?'

/** The `UITestFixture` JSON for a graph whose today is `today`. */
export function storeFixture(today: Day): string {
  const day = (offset: number) => addDays(today, offset)
  const weekday = (offset: number) =>
    new Date(`${day(offset)}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    })
  /** Local `time` on `day(offset)`, in seconds since 1970. */
  const at = (offset: number, time: string) => new Date(`${day(offset)}T${time}`).getTime() / 1000
  const due = weekday(3)

  const files: Record<string, FixtureFile> = {}
  const write = (path: string, modified: number, lines: string[]) => {
    files[`Documents/${path}`] = { contents: [...lines, ''].join('\n'), modified }
  }
  /** A daily note, changed on its own day, or this morning for a later day. */
  const daily = (offset: number, lines: string[]) => {
    write(`daily/${day(offset)}.md`, offset < 0 ? at(offset, '21:10') : at(0, '08:52'), lines)
  }
  /** A note with a fixed Reflect id, so every run indexes the same graph. */
  const note = (slug: string, index: number, modified: number, lines: string[]) => {
    const id = `01hv3xq7c2dm8k4t9w5e6r1s${String(index).padStart(2, '0')}`
    write(`notes/${slug}.md`, modified, ['---', `id: ${id}`, '---', ...lines])
  }

  daily(0, [
    `## Morning`,
    `- Coffee with [[Ava Patel]] about the [[Studio Rebrand]] kickoff`,
    `  - She wants three directions by ${due}, not one`,
    `  - Ask [[Leo Martins]] to join the type review`,
    `- Finished chapter 4 of [[Thinking in Systems]] #book`,
    ``,
    `## To do`,
    `+ [ ] Send the moodboard to [[Ava Patel]]`,
    `+ [ ] Book the ryokan in Arashiyama for [[Kyoto Trip]]`,
    `+ [x] 30 minute run along the river`,
    ``,
    `## Ideas`,
    `- A weekly review template that starts from last week's open tasks #idea`,
  ])
  daily(-1, [
    `- Planning call for [[Kyoto Trip]] with [[Leo Martins]]`,
    `+ [x] Renew passport`,
    `- Draft brief for [[Studio Rebrand]]: calm, warm, more editorial`,
  ])
  daily(-3, [
    `- Lunch with [[Ava Patel]]. She is moving the studio to Lisbon in spring.`,
    `+ [ ] Read the [[Thinking in Systems]] notes again before ${weekday(6)}`,
  ])
  daily(-5, [
    `- Sketched three logo directions for [[Studio Rebrand]]`,
    `+ [ ] Ask [[Ava Patel]] for the brand guidelines PDF`,
  ])
  daily(-7, [`- Weekly review. Moved 4 tasks forward. #review`])
  daily(1, [`+ [ ] Type review with [[Leo Martins]] at 2pm`])
  daily(3, [`+ [ ] Present three directions for [[Studio Rebrand]]`])

  note('studio-rebrand', 3, at(0, '09:36'), [
    `# Studio Rebrand`,
    ``,
    `Client: [[Ava Patel]], Northlight Studio. Launch in March.`,
    ``,
    `## Direction`,
    `- Calm, warm, more editorial`,
    `- One serif, one sans, nothing else`,
    ``,
    `## Next`,
    `+ [ ] Three directions by ${due}`,
    `+ [ ] Type review with [[Leo Martins]]`,
    `+ [x] Collect references`,
  ])
  note('ava-patel', 1, at(0, '09:12'), [
    `# Ava Patel`,
    ``,
    `- Creative director at Northlight Studio #person`,
    `- Leads the [[Studio Rebrand]]`,
    `- Prefers short written updates over calls`,
    `- Moving the studio to Lisbon in spring`,
  ])
  note('kyoto-trip', 4, at(-1, '19:48'), [
    `# Kyoto Trip`,
    ``,
    `April 3 to 12, with [[Leo Martins]]. #travel`,
    ``,
    `- Day 1: Higashiyama walk, dinner in Pontocho`,
    `- Day 2: Arashiyama bamboo grove at sunrise`,
    `- Day 3: Day trip to Nara`,
    `+ [ ] Book the ryokan in Arashiyama`,
    `+ [x] Buy the JR pass`,
  ])
  note('leo-martins', 2, at(-1, '14:05'), [
    `# Leo Martins`,
    ``,
    `- Type designer, old friend from art school #person`,
    `- Coming on the [[Kyoto Trip]]`,
  ])
  note('thinking-in-systems', 5, at(-3, '22:31'), [
    `# Thinking in Systems`,
    ``,
    `- Author: Donella Meadows #book`,
    `- Stocks change slowly. Flows are where you act.`,
    `- Feedback loops explain most surprises.`,
  ])
  note('weekly-review', 6, at(-7, '18:20'), [
    `# Weekly Review`,
    ``,
    `1. Clear the inbox`,
    `2. Look at every open task`,
    `3. Pick three priorities for next week`,
  ])
  note('reading-list', 7, at(-12, '11:02'), [
    `# Reading List`,
    ``,
    `- [[Thinking in Systems]] #book`,
    `- The Timeless Way of Building #book`,
    `- Four Thousand Weeks #book`,
  ])

  files['Library/Application Support/reflect-open/settings.json'] = {
    contents: JSON.stringify({
      mobileOnboarded: true,
      mobileStorage: 'local',
      aiProviders: [
        { id: PROVIDER_ID, provider: 'anthropic', model: 'claude-sonnet-5-5', keyHint: 'x1a2' },
      ],
      defaultAiProviderId: PROVIDER_ID,
    }),
  }

  const answer = [
    `Ava wants **three directions by ${due}**, not one. From your notes:`,
    '',
    '- Calm, warm, and more editorial',
    '- One serif and one sans, nothing else',
    '- Leo Martins should join the type review',
    '',
    'She also prefers short written updates over calls, so a written summary with the three directions will land best.',
  ].join('\n')

  return JSON.stringify({
    files,
    secrets: { [`ai-api-key:${PROVIDER_ID}`]: 'sk-ant-store-screenshots' },
    responses: { 'https://api.anthropic.com/v1/messages': anthropicStream(answer) },
  })
}

function addDays(day: Day, offset: number): Day {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

/** An Anthropic Messages API event stream that answers `text`. */
function anthropicStream(text: string): string {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return [
    event('message_start', {
      message: {
        id: 'msg_store',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
    event('message_stop', {}),
  ].join('')
}
