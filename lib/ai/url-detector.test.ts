import { describe, expect, it } from 'vitest'
import { extractUrls, findUnverifiedUrls } from './url-detector'

const LISTED = 'https://lemils.com/products/le-mils-budan-bold'
const LIST = [LISTED, 'https://lemils.com/policies/shipping-policy']

describe('extractUrls — what counts as a link', () => {
  it('finds a scheme-prefixed url', () => {
    expect(extractUrls(`Grab it at ${LISTED}`)).toEqual([LISTED])
  })

  it('finds a schemeless url that has a path', () => {
    expect(extractUrls('see lemils.com/products/budan for more')).toEqual([
      'lemils.com/products/budan',
    ])
  })

  it('ignores a bare domain', () => {
    expect(extractUrls('You can order on lemils.com whenever.')).toEqual([])
  })

  it('ignores a bare domain carrying only a trailing slash', () => {
    // Follows from the trailing-slash rule: if one trailing "/" is
    // insignificant, "lemils.com/" is the same bare domain as "lemils.com".
    expect(extractUrls('order on lemils.com/ whenever')).toEqual([])
  })

  it('treats a scheme-prefixed homepage as a link even with no real path', () => {
    expect(extractUrls('see https://lemils.com/')).toEqual(['https://lemils.com/'])
    expect(extractUrls('see https://lemils.com')).toEqual(['https://lemils.com'])
  })

  it('ignores ordinary prose that looks dotted', () => {
    expect(extractUrls('Open 7am-3pm, e.g. Mon.Tue, drinks are 3.50 each.')).toEqual([])
  })

  it('ignores an email address', () => {
    expect(extractUrls('Write to shopper@lemils.com any time.')).toEqual([])
  })

  it('finds multiple links and de-duplicates repeats', () => {
    const body = `First ${LIST[0]} then ${LIST[1]} then ${LIST[0]} again.`
    expect(extractUrls(body)).toEqual([LIST[0], LIST[1]])
  })
})

describe('extractUrls — trailing punctuation', () => {
  it('strips a full stop at a sentence boundary', () => {
    expect(extractUrls(`It is at ${LISTED}.`)).toEqual([LISTED])
  })

  it('strips a run of trailing punctuation', () => {
    expect(extractUrls(`Here: ${LISTED}?!`)).toEqual([LISTED])
    expect(extractUrls(`Here (${LISTED}),`)).toEqual([LISTED])
  })

  it('reduces the markdown form to the bare url', () => {
    expect(extractUrls(`[Budan](<${LISTED}>)`)).toEqual([LISTED])
  })

  it('keeps a query string intact', () => {
    const q = 'https://lemils.com/products/budan?variant=10oz'
    expect(extractUrls(`${q}.`)).toEqual([q])
  })
})

describe('findUnverifiedUrls — matching against the curated list', () => {
  it('passes a link that is on the list', () => {
    expect(findUnverifiedUrls(`Order at ${LISTED}.`, LIST)).toEqual([])
  })

  it('reports a link that differs by one character', () => {
    const off = 'https://lemils.com/products/le-mils-budan-bolds'
    expect(findUnverifiedUrls(`Order at ${off}`, LIST)).toEqual([off])
  })

  it('reports a link that is in venue knowledge but not on the list', () => {
    // The allowlist is curated, never derived: appearing in a retrieved
    // knowledge chunk earns a link nothing.
    const inKnowledgeOnly = 'https://lemils.com/blogs/blog/so-whats-chicory'
    expect(findUnverifiedUrls(`Read ${inKnowledgeOnly}`, LIST)).toEqual([inKnowledgeOnly])
  })

  it('reports every link when the list is empty', () => {
    expect(findUnverifiedUrls(`Order at ${LISTED}`, [])).toEqual([LISTED])
  })

  it('never reports a bare domain, even with an empty list', () => {
    expect(findUnverifiedUrls('Order on lemils.com any time.', [])).toEqual([])
  })

  it('reports each offending link once, keeping the others', () => {
    const bad = 'https://lemils.com/products/nope'
    const body = `Try ${LISTED} or ${bad}, or ${bad} again.`
    expect(findUnverifiedUrls(body, LIST)).toEqual([bad])
  })
})

describe('findUnverifiedUrls — a single trailing slash is insignificant', () => {
  it('matches a draft with no slash against a listed url with one', () => {
    expect(findUnverifiedUrls('see https://lemils.com', ['https://lemils.com/'])).toEqual([])
  })

  it('matches a draft with a slash against a listed url without one', () => {
    expect(findUnverifiedUrls('see https://lemils.com/', ['https://lemils.com'])).toEqual([])
  })

  it('reconciles the slash on a real path too', () => {
    expect(findUnverifiedUrls(`see ${LISTED}/`, [LISTED])).toEqual([])
    expect(findUnverifiedUrls(`see ${LISTED}`, [`${LISTED}/`])).toEqual([])
  })

  it('does NOT match across a different scheme', () => {
    expect(findUnverifiedUrls('see http://lemils.com/', ['https://lemils.com/'])).toEqual([
      'http://lemils.com/',
    ])
  })

  it('normalizes nothing else: case, query and path stay exact', () => {
    expect(findUnverifiedUrls('see https://lemils.com/Products/Budan', [
      'https://lemils.com/products/budan',
    ])).toEqual(['https://lemils.com/Products/Budan'])
    expect(findUnverifiedUrls('see https://lemils.com/products/budan?v=1', [
      'https://lemils.com/products/budan',
    ])).toEqual(['https://lemils.com/products/budan?v=1'])
  })

  it('does not collapse a doubled trailing slash onto a listed single one', () => {
    // Exactly one slash is removed, so "…/budan//" stays "…/budan/", which is
    // still not the listed "…/budan". A doubled slash is a different path and
    // holding it is the safe direction.
    expect(findUnverifiedUrls(`see ${LISTED}//`, [LISTED])).toEqual([`${LISTED}//`])
  })

  it('tolerates whitespace around a stored list entry', () => {
    expect(findUnverifiedUrls(`see ${LISTED}`, [`  ${LISTED}  `])).toEqual([])
  })
})
