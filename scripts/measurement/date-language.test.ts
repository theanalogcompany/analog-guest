import { describe, expect, it } from 'vitest'

import {
  countByKind,
  findDateLanguage,
  type DateLanguageKind,
} from './date-language'

function kinds(body: string): DateLanguageKind[] {
  return [...new Set(findDateLanguage(body).map((m) => m.kind))].sort()
}

function phrasesOf(body: string, kind: DateLanguageKind): string[] {
  return findDateLanguage(body)
    .filter((m) => m.kind === kind)
    .map((m) => m.phrase)
}

describe('findDateLanguage', () => {
  describe('the incident', () => {
    // The literal drafted reply from Le Mil's, 2026-09-22. If the detector
    // cannot see this one, the whole measurement is worthless.
    const INCIDENT =
      "not yet, that's planned for September 2026. exact date will be on our Instagram @lemilscoffee when it's confirmed."

    it('flags the year in the drafted reply that opened the ticket', () => {
      expect(phrasesOf(INCIDENT, 'year_stated')).toEqual(['2026'])
    })

    it('flags the month name separately, since it is the same defect a month earlier', () => {
      expect(phrasesOf(INCIDENT, 'month_named')).toEqual(['september'])
    })

    it('finds nothing person-shaped in it', () => {
      expect(phrasesOf(INCIDENT, 'person_shaped')).toEqual([])
    })
  })

  describe('year_stated', () => {
    it('flags a bare year', () => {
      expect(phrasesOf('should be running by 2027', 'year_stated')).toEqual([
        '2027',
      ])
    })

    // NAMED FOR WHAT THEY ACTUALLY CHECK. Both of these pass because neither
    // fixture contains four consecutive digits, NOT because of any word
    // boundary — an earlier pair was named for a guard it never exercised.
    it('finds no year in a price, which has no four-digit run', () => {
      expect(phrasesOf('the cortado is $20.26', 'year_stated')).toEqual([])
    })

    it('finds no year in a 24-hour clock time, which has no four-digit run', () => {
      expect(phrasesOf('we close at 20:26', 'year_stated')).toEqual([])
    })

    // This one is the 19xx/20xx restriction, and it is the only test here that
    // exercises it.
    it('does NOT read a four-digit number outside the 19xx/20xx range as a year', () => {
      expect(phrasesOf('we roast 3000 bags a week', 'year_stated')).toEqual([])
    })

    // KNOWN FALSE POSITIVES, pinned rather than hidden. Both inflate the
    // DEFECT counter, which is the safe direction: a human reads the line and
    // dismisses it. The venue's street address really does render in
    // ## Venue facts, so the first is reachable.
    it.each(["we're at 2026 Mission St", "that'll be $1999"])(
      'reports a year it should not, in the safe direction: %s',
      (body) => {
        expect(phrasesOf(body, 'year_stated')).not.toEqual([])
      },
    )
  })

  describe('numeric_date', () => {
    it('flags an ISO date, the exact shape ## Right now hands the model', () => {
      expect(phrasesOf('it starts 2026-09-26', 'numeric_date')).toEqual([
        '2026-09-26',
      ])
    })

    it('flags a slashed date', () => {
      expect(phrasesOf('it starts 9/26', 'numeric_date')).toEqual(['9/26'])
    })

    it('flags a slashed date carrying a year', () => {
      expect(phrasesOf('it starts 09/26/2026', 'numeric_date')).toEqual([
        '09/26/2026',
      ])
    })

    // Both of these would fire on ordinary copy, and both were caught before
    // the detector was used on anything.
    it('does NOT read a price as a date', () => {
      expect(phrasesOf('that one is $5.50', 'numeric_date')).toEqual([])
    })

    it('does NOT read 24/7 as a date', () => {
      expect(phrasesOf('the app is up 24/7', 'numeric_date')).toEqual([])
    })

    it('flags a written-out day-of-month, which is the same thing spelled out', () => {
      expect(phrasesOf('it starts September 26th', 'numeric_date')).toEqual([
        'september 26th',
      ])
    })
  })

  describe('month_named', () => {
    it('flags a bare month name', () => {
      expect(phrasesOf('sometime in March', 'month_named')).toEqual(['march'])
    })

    // "may" is the one month that is also a common modal verb. Matching it
    // bare would fire on ordinary hedging in a large share of replies and bury
    // the real signal, so it matches only where it reads as a month.
    it.each([
      'that may be sold out',
      'you may want the oat',
      'it may not be ready',
    ])('does NOT flag "may" used as a verb: %s', (body) => {
      expect(phrasesOf(body, 'month_named')).toEqual([])
    })

    it.each([
      ['in may', 'the loft opens in May'],
      ['by may', 'should be done by May'],
      ['may 2027', 'planned for May 2027'],
      ['may 3rd', 'it runs May 3rd'],
    ])('flags "may" where it reads as a month: %s', (phrase, body) => {
      expect(phrasesOf(body, 'month_named')).toContain(phrase)
    })

    it('flags an abbreviated month only when it carries its dot', () => {
      expect(phrasesOf('starts in Sept.', 'month_named')).toEqual(['sept.'])
      expect(phrasesOf('a marzipan croissant', 'month_named')).toEqual([])
    })
  })

  describe('person_shaped', () => {
    it.each([
      ['today', 'we are open today'],
      ['tonight', 'it runs tonight'],
      ['tomorrow', 'back tomorrow'],
      ['later this month', 'it is later this month'],
      ['next week', 'starting next week'],
      ['friday', 'it kicks off Friday'],
    ])('counts %s as a win', (phrase, body) => {
      expect(phrasesOf(body, 'person_shaped')).toContain(phrase)
    })

    it.each([
      "the date isn't set yet",
      'the date isn’t set yet',
      'no exact date yet',
      'no firm date',
      "we don't have a date",
      'nothing locked in',
    ])(
      'counts saying the date is not set, the answer the rule asks for: %s',
      (body) => {
        expect(phrasesOf(body, 'person_shaped')).not.toEqual([])
      },
    )

    // The positive counter is the one place a false positive flatters the
    // after arm, so the two riskiest words are pinned as non-matches.
    it('does NOT read "sat" or "sun" as a weekday', () => {
      expect(phrasesOf('I sat outside in the sun', 'person_shaped')).toEqual([])
    })

    it('does NOT count "soon", which is the vagueness the rule replaces', () => {
      expect(phrasesOf('it should be running soon', 'person_shaped')).toEqual(
        [],
      )
    })

    it('counts a weekday only once, so the positive counter is not inflated', () => {
      expect(phrasesOf('come by on Friday', 'person_shaped')).toEqual([
        'friday',
      ])
    })

    // KNOWN NON-GOALS, pinned so nobody reads this counter as a verdict.
    //
    // Every one of these scores a win while saying NOTHING about when the
    // thing asked about happens, and that lands in the flattering direction.
    // The last is R2's own prescribed hours answer, so the hours control
    // cannot score anything else. The counter is advisory: a run is read by
    // reading the bodies. Narrowing it would need a notion of what was asked,
    // which is a judgement, not a regex.
    it.each([
      'we get busy on the weekend',
      "we're closed Monday",
      'no matcha today, sorry',
      '10pm tonight',
    ])('counts an incidental temporal word as person-shaped: %s', (body) => {
      expect(phrasesOf(body, 'person_shaped')).not.toEqual([])
    })
  })

  describe('overlaps and bookkeeping', () => {
    it('reports a written-out date as BOTH numeric_date and month_named', () => {
      // Deliberate: the two say different things about the same phrase, and
      // collapsing them would hide the stronger signal behind the weaker one.
      expect(kinds('it starts September 26th')).toEqual([
        'month_named',
        'numeric_date',
      ])
    })

    it('carries enough surrounding text to judge the line by reading', () => {
      const [match] = findDateLanguage(
        "not yet, that's planned for September 2026 in the loft area",
      ).filter((m) => m.kind === 'year_stated')
      expect(match.context).toContain('planned for September 2026')
    })

    // The patterns are module constants carrying /g, reused across every call,
    // so this pins that a run of many bodies gets the same answer for each.
    //
    // It does NOT guard the explicit `re.lastIndex = 0` in the source, and the
    // distinction is worth stating rather than implying: `exec` resets
    // lastIndex itself on the call that returns null, so deleting that line
    // passes every test here (mutation-verified). The line is insurance
    // against a future early return in that loop, and nothing behavioural can
    // reach it while the loop always runs to exhaustion.
    it('returns the same matches when called repeatedly', () => {
      const body = 'planned for September 2026, maybe 2027'
      const first = findDateLanguage(body)
      const second = findDateLanguage(body)
      const third = findDateLanguage(body)
      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(phrasesOf(body, 'year_stated')).toEqual(['2026', '2027'])
    })

    it('finds nothing in a reply with no date language at all', () => {
      expect(findDateLanguage('yeah, oat and almond')).toEqual([])
    })
  })

  describe('countByKind', () => {
    it('returns a zero for every kind on an empty match list', () => {
      expect(countByKind([])).toEqual({
        year_stated: 0,
        numeric_date: 0,
        month_named: 0,
        person_shaped: 0,
      })
    })

    it('counts each kind', () => {
      const counts = countByKind(
        findDateLanguage('planned for September 2026, so come by Friday'),
      )
      expect(counts.year_stated).toBe(1)
      expect(counts.month_named).toBe(1)
      expect(counts.person_shaped).toBe(1)
      expect(counts.numeric_date).toBe(0)
    })
  })
})
