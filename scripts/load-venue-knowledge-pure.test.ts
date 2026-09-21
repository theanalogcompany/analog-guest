import { describe, expect, it } from 'vitest'
import {
  ProposalSchema,
  checkSplitSafety,
  decideLoadAction,
  diffAgainstBaseline,
  embeddingCacheKey,
  resolveReplacesId,
  cosineSimilarity,
  diffSpecifics,
  entrySimilarity,
  extractSpecifics,
  findDuplicateRowIds,
  parseArgs,
  parseEmbedding,
  percentile,
  suggestVerdict,
  summarizeDistribution,
  type BaselineRow,
  type LoadableRow,
  type Proposal,
} from './load-venue-knowledge-pure'

const VALID: Proposal = {
  row_id: 'P01',
  action: 'new',
  replaces_id: null,
  dedup_status: 'unchecked',
  contains_url: false,
  primary_tags: ['logistics'],
  secondary_tags: ['retail'],
  content: 'Something true about the venue.',
  source_ref: 'web:https://example.com/',
  note: '',
}

describe('ProposalSchema', () => {
  it('accepts a well-formed new row', () => {
    expect(ProposalSchema.parse(VALID).row_id).toBe('P01')
  })

  it('rejects action=replace with no replaces_id', () => {
    const r = ProposalSchema.safeParse({ ...VALID, action: 'replace' })
    expect(r.success).toBe(false)
  })

  it('rejects action=new carrying a replaces_id', () => {
    const r = ProposalSchema.safeParse({
      ...VALID,
      replaces_id: '528f8bd1-614a-47d4-a30b-a09693cd1b41',
    })
    expect(r.success).toBe(false)
  })

  // The canonical set lives in lib/schemas/knowledge-tags. This asserts the
  // import is load-bearing: a hand-copied list would drift and this would
  // keep passing against the stale copy.
  it('rejects a non-canonical primary tag', () => {
    const r = ProposalSchema.safeParse({ ...VALID, primary_tags: ['personality'] })
    expect(r.success).toBe(false)
  })

  it('accepts the namespaced form the canonical checker allows', () => {
    expect(ProposalSchema.parse({ ...VALID, primary_tags: ['staff_phoebe'] }).primary_tags).toEqual([
      'staff_phoebe',
    ])
  })
})

describe('findDuplicateRowIds', () => {
  it('finds a repeated row_id', () => {
    expect(findDuplicateRowIds([VALID, { ...VALID }, { ...VALID, row_id: 'P02' }])).toEqual(['P01'])
  })

  it('returns nothing when every row_id is distinct', () => {
    expect(findDuplicateRowIds([VALID, { ...VALID, row_id: 'P02' }])).toEqual([])
  })
})

describe('parseArgs', () => {
  it('requires --venue', () => {
    expect(() => parseArgs([])).toThrow(/--venue/)
  })

  it('defaults to a dry run', () => {
    expect(parseArgs(['--venue', 'le-mils-coffee']).apply).toBe(false)
  })

  it('reads --apply', () => {
    expect(parseArgs(['--venue', 'x', '--apply']).apply).toBe(true)
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--venue', 'x', '--fource'])).toThrow(/unrecognized/)
  })
})

describe('parseEmbedding', () => {
  it('parses the pgvector string literal PostgREST returns', () => {
    expect(parseEmbedding('[0.5,-0.25,1]', 'x')).toEqual([0.5, -0.25, 1])
  })

  it('parses a real array', () => {
    expect(parseEmbedding([1, 2], 'x')).toEqual([1, 2])
  })

  // Load-bearing: a null embedding coerced to zeros would score 0 against
  // everything and read as "no duplicates found" — the failure this check
  // exists to make impossible.
  it('throws on null rather than yielding a zero vector', () => {
    expect(() => parseEmbedding(null, 'row-9')).toThrow(/row-9/)
  })

  it('throws on a bare number', () => {
    expect(() => parseEmbedding(7, 'x')).toThrow()
  })

  it('throws on a non-vector string', () => {
    expect(() => parseEmbedding('0.1,0.2', 'x')).toThrow(/bracketed/)
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12)
  })

  it('is -1 for opposed vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12)
  })

  // A dot product would return 10 here. Normalising is what makes the score
  // comparable across entries of different magnitude.
  it('normalises rather than returning a dot product', () => {
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1, 12)
  })

  it('throws on a dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(/dimension/)
  })

  it('throws on a zero-magnitude vector', () => {
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow(/zero-magnitude/)
  })
})

describe('entrySimilarity', () => {
  it('takes the max over chunk pairs, not the mean', () => {
    const a = [[1, 0]]
    const b = [
      [0, 1],
      [1, 0],
    ]
    // mean would be 0.5; max is 1
    expect(entrySimilarity(a, b)).toBeCloseTo(1, 12)
  })
})

describe('percentile / summarizeDistribution', () => {
  it('interpolates between neighbours', () => {
    expect(percentile([0, 1], 0.5)).toBeCloseTo(0.5, 12)
  })

  it('returns the endpoints at 0 and 1', () => {
    const xs = [0.1, 0.5, 0.9]
    expect(percentile(xs, 0)).toBe(0.1)
    expect(percentile(xs, 1)).toBe(0.9)
  })

  it('buckets scores and reports the spread', () => {
    const d = summarizeDistribution([0.01, 0.02, 0.51, 0.99])
    expect(d.count).toBe(4)
    expect(d.min).toBe(0.01)
    expect(d.max).toBe(0.99)
    expect(d.histogram[0]).toEqual({ lo: 0, hi: 0.05, count: 2 })
  })

  it('throws on empty input rather than reporting a band of zero', () => {
    expect(() => summarizeDistribution([])).toThrow()
  })
})

describe('extractSpecifics', () => {
  it('reads a price as money, not as a bare number', () => {
    const s = extractSpecifics('1 lb for $26 on lemils.com.')
    expect(s.money).toEqual(['$26'])
    expect(s.numbers).toEqual([])
    expect(s.measures).toEqual(['1lb'])
    expect(s.domains).toEqual(['lemils.com'])
  })

  it('keeps a decimal price whole', () => {
    expect(extractSpecifics('for $9.99 on lemils.com.').money).toEqual(['$9.99'])
  })

  it('separates centuries, which is the pair embeddings cannot tell apart', () => {
    expect(extractSpecifics('in the 16th century').ordinals).toEqual(['16thcentury'])
    expect(extractSpecifics('in the 17th century').ordinals).toEqual(['17thcentury'])
  })

  it('keeps a range whole rather than splitting it into two numbers', () => {
    const s = extractSpecifics('Let it drip 10-15 minutes.')
    expect(s.ranges).toEqual(['10-15minutes'])
    expect(s.numbers).toEqual([])
  })

  it('keeps a multiplied pack size whole', () => {
    expect(extractSpecifics('3 x 10 oz for $51').ranges).toEqual(['3x10oz'])
  })

  it('reads percentages', () => {
    expect(extractSpecifics('80% Indian Arabica and 20% Robusta').percentages).toEqual(['20%', '80%'])
    // A spaced form must normalise to the SAME token, or two entries writing
    // the fact differently read as a numeric divergence when they agree.
    expect(extractSpecifics('20 % chicory').percentages).toEqual(['20%'])
  })

  it('reads an email without also reading its domain', () => {
    const s = extractSpecifics('email shopper@lemils.com to start.')
    expect(s.emails).toEqual(['shopper@lemils.com'])
    expect(s.domains).toEqual([])
  })

  it('reads a year', () => {
    expect(extractSpecifics('started selling in January 2024.').years).toEqual(['2024'])
  })

  it('collects proper nouns but drops sentence-start filler', () => {
    const s = extractSpecifics('The Newark Farmers Market is open.')
    expect(s.properNouns).toContain('Newark')
    expect(s.properNouns).not.toContain('The')
  })
})

describe('diffSpecifics', () => {
  it('does not flag a purely typographic difference in the same number', () => {
    const d = diffSpecifics(
      extractSpecifics('The blend is 80% Arabica.'),
      extractSpecifics('The blend is 80 % Arabica.'),
    )
    expect(d.numericDivergence).toBe(false)
  })

  it('flags the 16th/17th century pair as a numeric divergence', () => {
    const d = diffSpecifics(
      extractSpecifics('Baba Budan brought coffee to India in the 17th century.'),
      extractSpecifics('Baba Budan brought coffee to India in the 16th century.'),
    )
    expect(d.numericDivergence).toBe(true)
    expect(d.onlyLeft.ordinals).toEqual(['17thcentury'])
    expect(d.onlyRight.ordinals).toEqual(['16thcentury'])
  })

  it('does not flag two entries stating the same numbers', () => {
    const a = extractSpecifics('1 lb for $26.')
    expect(diffSpecifics(a, a).numericDivergence).toBe(false)
  })

  it('does not flag when only one side states any numeric at all', () => {
    const d = diffSpecifics(
      extractSpecifics('Wholesale pricing is available on request.'),
      extractSpecifics('A 5 lb bag is $96.'),
    )
    expect(d.numericDivergence).toBe(false)
  })
})

describe('suggestVerdict', () => {
  // The spec's vocabulary includes DUPLICATE; this function must never
  // produce it. Dropping an entry costs the venue a fact and needs a reading.
  it('never suggests DUPLICATE', () => {
    const diff = diffSpecifics(extractSpecifics('a'), extractSpecifics('a'))
    const seen = new Set(
      [0, 0.5, 0.9, 0.99, 1].map((s) => suggestVerdict('new', s, 0.8, diff)),
    )
    expect(seen.has('REPLACES')).toBe(false)
    expect([...seen].every((v) => v !== ('DUPLICATE' as never))).toBe(true)
  })

  it('is REPLACES for a confirmed replacement whatever the score', () => {
    expect(suggestVerdict('replace', 0.1, 0.8, null)).toBe('REPLACES')
  })

  it('is NEW below the band', () => {
    expect(suggestVerdict('new', 0.79, 0.8, null)).toBe('NEW')
  })

  it('is at least BORDERLINE at exactly the band', () => {
    expect(suggestVerdict('new', 0.8, 0.8, null)).toBe('BORDERLINE')
  })

  it('escalates to CONFLICT_CANDIDATE when specifics diverge on shared ground', () => {
    const diff = diffSpecifics(
      extractSpecifics('A 1 lb bag is $26 and a 10 oz bag is $17.'),
      extractSpecifics('A 1 lb bag is $29 and a 10 oz bag is $17.'),
    )
    expect(diff.sharedNumericCount).toBeGreaterThan(0)
    expect(suggestVerdict('new', 0.95, 0.8, diff)).toBe('CONFLICT_CANDIDATE')
  })

  it('stays BORDERLINE when the two sides share no numeric ground', () => {
    const diff = diffSpecifics(
      extractSpecifics('Our cold foams contain dairy.'),
      extractSpecifics('The Pink Panther foam is vegan.'),
    )
    expect(suggestVerdict('new', 0.95, 0.8, diff)).toBe('BORDERLINE')
  })

  it('is NEW when there is no neighbour at all', () => {
    expect(suggestVerdict('new', null, 0.8, null)).toBe('NEW')
  })
})

describe('checkSplitSafety', () => {
  const bodies = [
    { rowId: 'P05', content: 'Estate Secret is a chicory blend. 1 lb for $26 on lemils.com.' },
    { rowId: 'P15', content: 'Every coffee can be browsed on lemils.com, and orders over $50 ship free.' },
    { rowId: 'P20', content: 'All coffee sales on lemils.com are final. Items can be returned within 30 days.' },
  ]

  it('finds nothing against the real splitter', () => {
    expect(checkSplitSafety(bodies)).toEqual([])
  })

  // Without this the suite cannot distinguish "domains survive" from "the
  // detector cannot fire". Against the real splitter a domain can never break
  // (it has no whitespace, and the splitter needs whitespace after the
  // punctuation), so the seam is the only way to exercise the failure branch.
  it('reports a break when the splitter does cut a domain', () => {
    const breaking = (body: string): string[] => body.split('.com').map((p, i) => (i === 0 ? p : `com${p}`))
    const found = checkSplitSafety(bodies, breaking)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.brokenToken).toBe('lemils.com')
  })

  it('ignores bodies with no domain in them', () => {
    expect(checkSplitSafety([{ rowId: 'P21', content: 'Coffee grows in Chikmagalur.' }])).toEqual([])
  })
})

// ── replaces_id resolution ──────────────────────────────────────────────────

const IDS = [
  'c2d7be4c-e5cf-437b-a4e8-bccf267e61ff',
  'c2d7be4c-0000-0000-0000-000000000000',
  '1c973b3e-5466-4ee5-8df7-cb07ab8996a1',
]

describe('resolveReplacesId', () => {
  it('resolves a full uuid', () => {
    const r = resolveReplacesId('1c973b3e-5466-4ee5-8df7-cb07ab8996a1', IDS)
    expect(r).toEqual({ ok: true, id: '1c973b3e-5466-4ee5-8df7-cb07ab8996a1', viaPrefix: false })
  })

  it('resolves an 8-char prefix that matches exactly one row', () => {
    const r = resolveReplacesId('1c973b3e', IDS)
    expect(r).toEqual({ ok: true, id: '1c973b3e-5466-4ee5-8df7-cb07ab8996a1', viaPrefix: true })
  })

  // Both refusals matter: this resolves the target of an in-place overwrite
  // of reviewed content, so guessing is never acceptable.
  it('refuses a prefix that matches nothing', () => {
    expect(resolveReplacesId('deadbeef', IDS)).toEqual({ ok: false, reason: 'no_match', matches: [] })
  })

  it('refuses a prefix that matches more than one row', () => {
    const r = resolveReplacesId('c2d7be4c', IDS)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous')
      expect(r.matches).toHaveLength(2)
    }
  })

  // Venue isolation is a property of the id list the caller passes. If the
  // caller ever passed unscoped ids, a prefix could reach another venue's
  // row — so the test states the contract the caller has to keep.
  it('can only ever return an id it was given', () => {
    const r = resolveReplacesId('1c973b3e', ['1c973b3e-5466-4ee5-8df7-cb07ab8996a1'])
    expect(r.ok && IDS.includes(r.id)).toBe(true)
    expect(resolveReplacesId('1c973b3e', []).ok).toBe(false)
  })
})

describe('ProposalSchema replaces_id forms', () => {
  it('accepts the 8-char prefix form P68 uses', () => {
    const r = ProposalSchema.safeParse({ ...VALID, action: 'replace', replaces_id: 'c2d7be4c' })
    expect(r.success).toBe(true)
  })

  it('rejects a prefix shorter than 8 chars', () => {
    const r = ProposalSchema.safeParse({ ...VALID, action: 'replace', replaces_id: 'c2d7be' })
    expect(r.success).toBe(false)
  })

  it('rejects a non-hex id', () => {
    const r = ProposalSchema.safeParse({ ...VALID, action: 'replace', replaces_id: 'not-an-id-at-all' })
    expect(r.success).toBe(false)
  })
})

// ── load decision table ─────────────────────────────────────────────────────

const UNRELATED: LoadableRow = { id: 'row-unrelated', isProcessed: true, proposalRowId: null }

describe('decideLoadAction', () => {
  it('inserts a new proposal the venue has never seen', () => {
    expect(decideLoadAction({ row_id: 'P01', action: 'new' }, null, [UNRELATED])).toEqual({
      kind: 'insert',
    })
  })

  it('updates the resolved target for a replacement', () => {
    expect(decideLoadAction({ row_id: 'P68', action: 'replace' }, 'target-id', [UNRELATED])).toEqual({
      kind: 'update',
      id: 'target-id',
      reason: 'replace',
    })
  })

  it('throws rather than guessing when a replacement has no resolved target', () => {
    expect(() => decideLoadAction({ row_id: 'P68', action: 'replace' }, null, [])).toThrow(/P68/)
  })

  // The re-run no-op.
  it('skips a proposal already loaded and embedded', () => {
    const rows: LoadableRow[] = [{ id: 'row-1', isProcessed: true, proposalRowId: 'P01' }]
    expect(decideLoadAction({ row_id: 'P01', action: 'new' }, null, rows)).toEqual({
      kind: 'skip',
      reason: 'already_loaded',
      id: 'row-1',
    })
  })

  it('skips an already-applied replacement too, rather than replacing twice', () => {
    const rows: LoadableRow[] = [{ id: 'target-id', isProcessed: true, proposalRowId: 'P68' }]
    expect(decideLoadAction({ row_id: 'P68', action: 'replace' }, 'target-id', rows)).toEqual({
      kind: 'skip',
      reason: 'already_loaded',
      id: 'target-id',
    })
  })

  // Load-bearing: skipping on the stamp ALONE would strand a row that was
  // written but never embedded — present in the table, invisible to
  // retrieval, and skipped forever by every later run.
  it('resumes a stamped row whose embedding never landed', () => {
    const rows: LoadableRow[] = [{ id: 'row-1', isProcessed: false, proposalRowId: 'P01' }]
    expect(decideLoadAction({ row_id: 'P01', action: 'new' }, null, rows)).toEqual({
      kind: 'update',
      id: 'row-1',
      reason: 'resume_unprocessed',
    })
  })

  it('does not confuse one proposal row_id with another', () => {
    const rows: LoadableRow[] = [{ id: 'row-1', isProcessed: true, proposalRowId: 'P02' }]
    expect(decideLoadAction({ row_id: 'P01', action: 'new' }, null, rows).kind).toBe('insert')
  })

  it('a whole second run over an applied load is entirely skips', () => {
    const entries = [
      { row_id: 'P01', action: 'new' as const },
      { row_id: 'P02', action: 'new' as const },
      { row_id: 'P68', action: 'replace' as const },
    ]
    const rows: LoadableRow[] = [
      { id: 'a', isProcessed: true, proposalRowId: 'P01' },
      { id: 'b', isProcessed: true, proposalRowId: 'P02' },
      { id: 'c', isProcessed: true, proposalRowId: 'P68' },
    ]
    const kinds = entries.map((e) => decideLoadAction(e, 'c', rows).kind)
    expect(kinds).toEqual(['skip', 'skip', 'skip'])
  })
})

describe('embeddingCacheKey', () => {
  it('is stable for the same model and text', () => {
    expect(embeddingCacheKey('voyage-3-large', 'hello')).toBe(embeddingCacheKey('voyage-3-large', 'hello'))
  })

  it('differs on text', () => {
    expect(embeddingCacheKey('voyage-3-large', 'a')).not.toBe(embeddingCacheKey('voyage-3-large', 'b'))
  })

  // Without the model in the key, switching models would silently serve
  // vectors from a different space and every score would be meaningless.
  it('differs on model', () => {
    expect(embeddingCacheKey('voyage-3-large', 'a')).not.toBe(embeddingCacheKey('voyage-3', 'a'))
  })
})

describe('diffAgainstBaseline', () => {
  const row = (rowId: string, suggested: string, topLabel: string | null, topScore: number | null): BaselineRow => ({
    rowId,
    suggested,
    topLabel,
    topScore,
  })

  it('reports a verdict change', () => {
    const c = diffAgainstBaseline(
      [row('P02', 'BORDERLINE', 'x', 0.88)],
      [row('P02', 'NEW', 'x', 0.7)],
    )
    expect(c).toHaveLength(1)
    expect(c[0]!.kind).toBe('verdict')
  })

  it('reports a moved nearest neighbour even when the verdict holds', () => {
    const c = diffAgainstBaseline(
      [row('P05', 'NEW', 'old-neighbour', 0.7)],
      [row('P05', 'NEW', 'new-neighbour', 0.71)],
    )
    expect(c).toHaveLength(1)
    expect(c[0]!.kind).toBe('neighbour')
  })

  // Re-embedding identical text can move a score in the last decimals.
  // Reporting that would bury the changes that mean something.
  it('ignores score drift alone', () => {
    expect(diffAgainstBaseline([row('P05', 'NEW', 'n', 0.7)], [row('P05', 'NEW', 'n', 0.7004)])).toEqual([])
  })

  it('reports added and removed rows', () => {
    const c = diffAgainstBaseline([row('P54', 'NEW', 'n', 0.5)], [row('P68', 'REPLACES', null, null)])
    expect(c.map((x) => [x.rowId, x.kind])).toEqual([
      ['P54', 'removed'],
      ['P68', 'added'],
    ])
  })
})
