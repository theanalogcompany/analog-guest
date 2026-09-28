import { describe, expect, it } from 'vitest'
import { classifyBhadraReply, meetsBar } from './knowledge-context-language'

describe('classifyBhadraReply (TAC-547)', () => {
  it('passes a correct Bhadra answer', () => {
    const v = classifyBhadraReply('Bhadra is best as espresso or in a moka pot, with milk.')
    expect(meetsBar(v)).toBe(true)
  })

  it('fails the device draft verbatim', () => {
    const v = classifyBhadraReply('Same as the pour over: 21, 22g at a 1:15 ratio, three pours.')
    expect(v.namesPourOver).toBe(true)
    expect(meetsBar(v)).toBe(false)
  })

  it('fails a reply carrying the recipe NUMBERS even without the words', () => {
    const v = classifyBhadraReply('Go 21-22g at a 1:15 ratio and finish under three minutes.')
    expect(v.namesPourOverRecipeNumbers).toBe(true)
    expect(meetsBar(v)).toBe(false)
  })

  it('fails a correct method that forgets the milk', () => {
    expect(meetsBar(classifyBhadraReply('Pull it as espresso.'))).toBe(false)
  })

  it('fails a milky answer that names no method', () => {
    expect(meetsBar(classifyBhadraReply('Drink it with milk.'))).toBe(false)
  })

  it.each(['pour over', 'pour-over', 'pourover', 'V60'])('catches %s', (s) => {
    expect(classifyBhadraReply(`Try a ${s}.`).namesPourOver).toBe(true)
  })

  it('counts a cortado or latte as milk, since both are milk drinks', () => {
    expect(classifyBhadraReply('espresso, great as a cortado').namesMilk).toBe(true)
  })

  it('reports what it matched, so a run can be read rather than trusted', () => {
    expect(classifyBhadraReply('espresso with milk').matched).toEqual(
      expect.arrayContaining(['espresso', 'milk']),
    )
  })
})
