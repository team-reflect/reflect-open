// The demo graph of the App Store screenshots, as a `UITestFixture` of the
// app (apps/ios/Sources/App/UITestFixture.swift).
//
// The simulator runs on the clock of the Mac, so every date comes from `today`
// and every weekday in the text is the weekday of a date in the graph.

/** A calendar day as `YYYY-MM-DD`. */
type Day = string

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
  const due = weekday(3)

  const notes: Record<string, string[]> = {
    [`daily/${day(0)}.md`]: [
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
    ],
    [`daily/${day(-1)}.md`]: [
      `- Planning call for [[Kyoto Trip]] with [[Leo Martins]]`,
      `+ [x] Renew passport`,
      `- Draft brief for [[Studio Rebrand]]: calm, warm, more editorial`,
    ],
    [`daily/${day(-3)}.md`]: [
      `- Lunch with [[Ava Patel]]. She is moving the studio to Lisbon in spring.`,
      `+ [ ] Read the [[Thinking in Systems]] notes again before ${weekday(6)}`,
    ],
    [`daily/${day(-5)}.md`]: [
      `- Sketched three logo directions for [[Studio Rebrand]]`,
      `+ [ ] Ask [[Ava Patel]] for the brand guidelines PDF`,
    ],
    [`daily/${day(-7)}.md`]: [`- Weekly review. Moved 4 tasks forward. #review`],
    [`daily/${day(1)}.md`]: [`+ [ ] Type review with [[Leo Martins]] at 2pm`],
    [`daily/${day(3)}.md`]: [`+ [ ] Present three directions for [[Studio Rebrand]]`],
    'notes/ava-patel.md': note(1, [
      `# Ava Patel`,
      ``,
      `- Creative director at Northlight Studio #person`,
      `- Leads the [[Studio Rebrand]]`,
      `- Prefers short written updates over calls`,
      `- Moving the studio to Lisbon in spring`,
    ]),
    'notes/leo-martins.md': note(2, [
      `# Leo Martins`,
      ``,
      `- Type designer, old friend from art school #person`,
      `- Coming on the [[Kyoto Trip]]`,
    ]),
    'notes/studio-rebrand.md': note(3, [
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
    ]),
    'notes/kyoto-trip.md': note(4, [
      `# Kyoto Trip`,
      ``,
      `April 3 to 12, with [[Leo Martins]]. #travel`,
      ``,
      `- Day 1: Higashiyama walk, dinner in Pontocho`,
      `- Day 2: Arashiyama bamboo grove at sunrise`,
      `- Day 3: Day trip to Nara`,
      `+ [ ] Book the ryokan in Arashiyama`,
      `+ [x] Buy the JR pass`,
    ]),
    'notes/thinking-in-systems.md': note(5, [
      `# Thinking in Systems`,
      ``,
      `- Author: Donella Meadows #book`,
      `- Stocks change slowly. Flows are where you act.`,
      `- Feedback loops explain most surprises.`,
    ]),
    'notes/weekly-review.md': note(6, [
      `# Weekly Review`,
      ``,
      `1. Clear the inbox`,
      `2. Look at every open task`,
      `3. Pick three priorities for next week`,
    ]),
    'notes/reading-list.md': note(7, [
      `# Reading List`,
      ``,
      `- [[Thinking in Systems]] #book`,
      `- The Timeless Way of Building #book`,
      `- Four Thousand Weeks #book`,
    ]),
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

  const settings = {
    mobileOnboarded: true,
    mobileStorage: 'local',
    aiProviders: [
      { id: PROVIDER_ID, provider: 'anthropic', model: 'claude-sonnet-5-5', keyHint: 'x1a2' },
    ],
    defaultAiProviderId: PROVIDER_ID,
  }

  const files: Record<string, string> = {
    'Library/Application Support/reflect-open/settings.json': JSON.stringify(settings),
  }
  for (const [path, lines] of Object.entries(notes)) {
    files[`Documents/${path}`] = [...lines, ''].join('\n')
  }

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

/** A note with a fixed Reflect id, so every run indexes the same graph. */
function note(index: number, lines: string[]): string[] {
  return ['---', `id: 01hv3xq7c2dm8k4t9w5e6r1s${String(index).padStart(2, '0')}`, '---', ...lines]
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
