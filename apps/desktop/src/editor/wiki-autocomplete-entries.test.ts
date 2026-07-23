import { describe, expect, it } from 'vitest'
import type { ContactMatch, WikiLinkSuggestion } from '@reflect/core'
import { buildAutocompleteEntries } from './wiki-autocomplete-entries'

function suggestion(overrides: Partial<WikiLinkSuggestion>): WikiLinkSuggestion {
  const target = overrides.target ?? 'Note'
  const alias = overrides.alias ?? null
  return {
    target,
    insertText: alias === null ? target : `${target}|${alias}`,
    path: 'notes/note.md',
    title: 'Note',
    alias,
    date: null,
    ...overrides,
  }
}

function contact(overrides: Partial<ContactMatch>): ContactMatch {
  return {
    fullName: 'Ada Lovelace',
    givenName: 'Ada',
    familyName: 'Lovelace',
    emails: ['ada@example.com'],
    phones: [],
    ...overrides,
  }
}

function contactCandidate(overrides: Partial<ContactMatch> = {}) {
  const value = contact(overrides)
  return { contact: value, target: value.fullName, ownerPath: null }
}

describe('buildAutocompleteEntries', () => {
  it('offers create when nothing matches the typed text exactly', () => {
    const entries = buildAutocompleteEntries('New Idea', [
      suggestion({ target: 'New Ideas Board', title: 'New Ideas Board' }),
    ])
    expect(entries.at(-1)).toEqual({ kind: 'create', title: 'New Idea' })
  })

  it('does not offer create on an exact title match (case-insensitive)', () => {
    const entries = buildAutocompleteEntries('roadmap', [
      suggestion({ target: 'Roadmap', title: 'Roadmap' }),
    ])
    expect(entries.every((entry) => entry.kind === 'suggestion')).toBe(true)
  })

  it('does not offer create on an exact alias match', () => {
    const entries = buildAutocompleteEntries('meetco', [
      suggestion({ target: 'Acme Corp', title: 'Acme Corp', alias: 'meetco' }),
    ])
    expect(entries.every((entry) => entry.kind === 'suggestion')).toBe(true)
  })

  it('does not offer create when a leading-emoji fallback candidate exists', () => {
    const entries = buildAutocompleteEntries('Business ideas', [
      suggestion({ target: '🧠 Business ideas', title: '🧠 Business ideas' }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['suggestion'])
  })

  it('does not offer create when multiple emoji titles make the fallback ambiguous', () => {
    const entries = buildAutocompleteEntries('Business ideas', [
      suggestion({
        target: '🧠 Business ideas',
        title: '🧠 Business ideas',
        path: 'notes/business-ideas.md',
      }),
      suggestion({
        target: '💡 Business ideas',
        title: '💡 Business ideas',
        path: 'notes/business-ideas-2.md',
      }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['suggestion', 'suggestion'])
  })

  it('does not offer create when an alias matches after emoji-space normalization', () => {
    const entries = buildAutocompleteEntries('🧠 Business ideas', [
      suggestion({ target: 'Incubator', title: 'Incubator', alias: '🧠Business ideas' }),
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(['suggestion'])
  })

  it('does not offer create for a full date (the daily suggestion covers it)', () => {
    const entries = buildAutocompleteEntries('2026-06-09', [
      suggestion({ target: '2026-06-09', title: '2026-06-09', path: null, date: '2026-06-09' }),
    ])
    expect(entries.every((entry) => entry.kind === 'suggestion')).toBe(true)
  })

  it('offers nothing for a blank query', () => {
    expect(buildAutocompleteEntries('  ', [])).toEqual([])
  })

  it('omits unsafe Create and contact rows when the consumer inserts wikilinks', () => {
    for (const reserved of ['[', ']', '|', '\\', '\r', '\n']) {
      const unsafeName = `A${reserved}B`
      expect(
        buildAutocompleteEntries(unsafeName, [], {
          offerCreate: true,
          contacts: [contactCandidate({ fullName: unsafeName })],
          requireSerializableWikiText: true,
        }),
      ).toEqual([])
    }
  })

  it('does not offer create when a generated date suggestion is present', () => {
    const entries = buildAutocompleteEntries('3 days ago', [
      suggestion({
        target: '2019-12-29',
        title: '2019-12-29',
        path: null,
        date: '2019-12-29',
        generated: { phrase: '3 days ago' },
      }),
    ])
    expect(entries.every((entry) => entry.kind === 'suggestion')).toBe(true)
  })

  it('does not offer create when the query reads as a date whose suggestion was filtered', () => {
    // Address verification drops a generated date whose key is owned by a
    // non-daily note; the query still reads as a date, so a note literally
    // titled "tomorrow" stays as noisy as ever.
    expect(
      buildAutocompleteEntries('tomorrow', [], {
        offerCreate: true,
        queryReadsAsDate: true,
      }),
    ).toEqual([])
  })

  it('does not offer create when an existing claim was filtered from suggestions', () => {
    expect(
      buildAutocompleteEntries('Roadmap', [], {
        offerCreate: true,
        claimedTargetKeys: ['roadmap'],
      }),
    ).toEqual([])
  })

  it('drops an exact-name contact when the query already has an existing claim', () => {
    expect(
      buildAutocompleteEntries('Ada Lovelace', [], {
        offerCreate: true,
        contacts: [contactCandidate()],
        claimedTargetKeys: ['ada lovelace'],
      }),
    ).toEqual([])
  })

  it('suppresses create and contact rows for a filtered fallback collision', () => {
    // Two notes titled `🧠 Ideas` are dropped by address verification, so the
    // fallback collision arrives only through the claimed keys. Creating a
    // bare `Ideas` would be refused by the writable resolver's fallback guard.
    const entries = buildAutocompleteEntries('Ideas', [], {
      offerCreate: true,
      contacts: [contactCandidate({ fullName: 'Ideas' })],
      claimedTargetKeys: ['🧠 ideas'],
    })
    expect(entries).toEqual([])
  })

  it('drops a claimed contact found by a partial query', () => {
    const entries = buildAutocompleteEntries('Road', [], {
      offerCreate: true,
      contacts: [contactCandidate({ fullName: 'Roadmap' })],
      claimedTargetKeys: ['roadmap'],
    })
    expect(entries).toEqual([{ kind: 'create', title: 'Road' }])
  })

  it('keeps an unclaimed contact when another candidate key is claimed', () => {
    const ada = contact({})
    const entries = buildAutocompleteEntries('Ada Lovelace', [], {
      offerCreate: true,
      contacts: [{ contact: ada, target: ada.fullName, ownerPath: null }],
      claimedTargetKeys: ['roadmap'],
    })
    expect(entries).toEqual([
      {
        kind: 'contact',
        contact: ada,
        target: 'Ada Lovelace',
        ownerPath: null,
      },
    ])
  })

  it('never offers create from unsettled (in-flight) suggestions', () => {
    // The visible list belongs to the previous query while fetching — a match
    // for the current text may be about to arrive.
    const entries = buildAutocompleteEntries('Roadmap', [], { offerCreate: false })
    expect(entries).toEqual([])
  })

  it('suppressing create still passes suggestion rows through', () => {
    const entries = buildAutocompleteEntries(
      'New Idea',
      [suggestion({ target: 'New Ideas Board', title: 'New Ideas Board' })],
      { offerCreate: false },
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('suggestion')
  })

  it('places contact rows after suggestions and before the create row', () => {
    const ada = contact({})
    const entries = buildAutocompleteEntries(
      'Ada L',
      [suggestion({ target: 'Ada Lovelace Notes', title: 'Ada Lovelace Notes' })],
      {
        offerCreate: true,
        contacts: [{ contact: ada, target: ada.fullName, ownerPath: null }],
      },
    )
    expect(entries.map((entry) => entry.kind)).toEqual(['suggestion', 'contact', 'create'])
    expect(entries[1]).toEqual({
      kind: 'contact',
      contact: ada,
      target: 'Ada Lovelace',
      ownerPath: null,
    })
  })

  it('drops a contact whose name already resolves to a suggestion', () => {
    const entries = buildAutocompleteEntries(
      'ada',
      [suggestion({ target: 'Ada Lovelace', title: 'Ada Lovelace' })],
      { offerCreate: true, contacts: [contactCandidate()] },
    )
    expect(entries.filter((entry) => entry.kind === 'contact')).toEqual([])
  })

  it('keeps an email-owned Contact when its name resolves to another note', () => {
    const ada = contact({})
    const entries = buildAutocompleteEntries(
      'ada',
      [suggestion({ target: 'Ada Lovelace', title: 'Ada Lovelace' })],
      {
        offerCreate: true,
        contacts: [{
          contact: ada,
          target: 'Augusta Ada King',
          ownerPath: 'notes/augusta.md',
        }],
      },
    )
    expect(entries.filter((entry) => entry.kind === 'contact')).toEqual([
      {
        kind: 'contact',
        contact: ada,
        target: 'Augusta Ada King',
        ownerPath: 'notes/augusta.md',
      },
    ])
  })

  it('drops an email-owned Contact when its owner already has a note row', () => {
    const ada = contact({})
    const entries = buildAutocompleteEntries(
      'ada',
      [
        suggestion({
          target: 'Augusta Ada King',
          title: 'Augusta Ada King',
          path: 'notes/augusta.md',
        }),
      ],
      {
        offerCreate: true,
        contacts: [{
          contact: ada,
          target: 'Augusta Ada King',
          ownerPath: 'notes/augusta.md',
        }],
      },
    )
    expect(entries.filter((entry) => entry.kind === 'contact')).toEqual([])
  })

  it('drops a contact covered by a suggestion alias', () => {
    const entries = buildAutocompleteEntries(
      'ada',
      [suggestion({ target: 'People/Ada', title: 'People/Ada', alias: 'Ada Lovelace' })],
      { offerCreate: true, contacts: [contactCandidate()] },
    )
    expect(entries.filter((entry) => entry.kind === 'contact')).toEqual([])
  })

  it('drops a contact covered by a leading-emoji fallback title', () => {
    const entries = buildAutocompleteEntries(
      'Ada Lovelace',
      [suggestion({ target: '🧠 Ada Lovelace', title: '🧠 Ada Lovelace' })],
      { offerCreate: true, contacts: [contactCandidate()] },
    )
    expect(entries.map((entry) => entry.kind)).toEqual(['suggestion'])
  })

  it('suppresses the create row when a contact covers the exact query', () => {
    // The contact row IS the create action (prefilled) — a bare Create row
    // beside it would just be the worse duplicate.
    const entries = buildAutocompleteEntries('ada lovelace', [], {
      offerCreate: true,
      contacts: [contactCandidate()],
    })
    expect(entries.map((entry) => entry.kind)).toEqual(['contact'])
  })

  it('suppresses Create for an exact blocked Contact without hiding note rows', () => {
    const note = suggestion({ target: 'Ada Notes', title: 'Ada Notes' })
    const entries = buildAutocompleteEntries('Ada Lovelace', [note], {
      offerCreate: true,
      blockedContactNames: ['Ada Lovelace'],
    })
    expect(entries).toEqual([{ kind: 'suggestion', suggestion: note }])
  })
})

describe('buildAutocompleteEntries — rich titles', () => {
  it('does not offer create when the raw rich title is already claimed', () => {
    const entries = buildAutocompleteEntries(
      'Meeting with [[Ada Lovelace|Ada]]',
      [
        suggestion({
          target: 'Meeting with Ada',
          title: 'Meeting with [[Ada Lovelace|Ada]]',
        }),
      ],
      {
        offerCreate: true,
        claimedTargetKeys: ['meeting with [[ada lovelace|ada]]'],
      },
    )
    expect(entries.some((entry) => entry.kind === 'create')).toBe(false)
  })

  it('does not offer create for a derived form whose key is claimed by a filtered note', () => {
    const entries = buildAutocompleteEntries('Meeting with Ada', [], {
      offerCreate: true,
      claimedTargetKeys: ['meeting with ada'],
    })
    expect(entries).toEqual([])
  })
})
