import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SCAN_REFERRAL_SOURCE, isScanReferral } from './referral-source'

// TAC-518. The predicate is three characters of logic and one decision: what
// counts as "this guest opened the thread from the venue's link". It is tested
// because it now has two callers that must agree — guest creation
// (lib/messaging/instagram/handle-events.ts) and the per-turn read in
// build-runtime-context — and because every widening anyone will be tempted by
// (trim, lowercase, startsWith, "any non-null source") arms a first-touch path
// for a guest who is not at the counter.
describe('isScanReferral', () => {
  it('accepts Meta\'s SHORTLINK source', () => {
    expect(isScanReferral('SHORTLINK')).toBe(true)
  })

  it('reads a missing referral as not a scan', () => {
    expect(isScanReferral(null)).toBe(false)
    expect(isScanReferral(undefined)).toBe(false)
    expect(isScanReferral('')).toBe(false)
  })

  // Meta documents other sources. A guest arriving from an ad or the
  // customer-chat plugin genuinely is not standing at the pickup counter, so
  // these are correct negatives, not gaps.
  it.each(['ADS', 'CUSTOMER_CHAT_PLUGIN', 'OPEN_THREAD', 'unknown-future-source'])(
    'reads %s as not a scan',
    (source) => {
      expect(isScanReferral(source)).toBe(false)
    },
  )

  // Each of these is a "helpful" normalization someone will propose. Every one
  // of them admits a value Meta has never sent, on a signal that decides
  // whether the agent treats a guest as being in the shop.
  it.each(['shortlink', 'ShortLink', ' SHORTLINK', 'SHORTLINK ', 'SHORTLINK_AD'])(
    'does NOT accept %s',
    (source) => {
      expect(isScanReferral(source)).toBe(false)
    },
  )

  it('exports the constant it matches on, so callers never respell it', () => {
    expect(SCAN_REFERRAL_SOURCE).toBe('SHORTLINK')
    expect(isScanReferral(SCAN_REFERRAL_SOURCE)).toBe(true)
  })
})

// SOURCE-LEVEL, and it has to be: a local `referral?.source === 'SHORTLINK'`
// behaves identically to the shared predicate for every input anyone would
// write a behavioural test for, so nothing else can tell the two apart until
// the day one of them changes. Same technique, and the same reason, as the
// filterByRelevance import assertion TAC-366 added to the Voices regen path.
//
// Guest creation is the older caller; the per-turn read is TAC-518's. They
// answer the same question at two different moments, and the whole point of
// this module is that they cannot answer it differently.
describe('both callers read the shared predicate, not their own copy', () => {
  const REPO = join(__dirname, '..', '..')
  const CALLERS = [
    join('lib', 'messaging', 'instagram', 'handle-events.ts'),
    join('lib', 'agent', 'build-runtime-context.ts'),
  ]

  it.each(CALLERS)('%s imports isScanReferral', (file) => {
    const src = readFileSync(join(REPO, file), 'utf-8')
    expect(src).toMatch(/import \{[^}]*\bisScanReferral\b[^}]*\} from '@\/lib\/schemas\/referral-source'/)
  })

  it.each(CALLERS)('%s spells the source value nowhere of its own', (file) => {
    const src = readFileSync(join(REPO, file), 'utf-8')
    // Comments may name it; code may not. Strip line and block comments first,
    // or the header explaining the rule would fail the rule.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('SHORTLINK')
  })
})
