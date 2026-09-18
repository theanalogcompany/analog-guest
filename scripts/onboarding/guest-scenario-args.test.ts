import { describe, expect, it } from 'vitest'
import { parseGuestScenarioArgs } from './guest-scenario-args'

const BASE = ['node', 'run-guest-scenario.ts']

describe('parseGuestScenarioArgs', () => {
  it('parses the required flags', () => {
    const result = parseGuestScenarioArgs([
      ...BASE,
      '--venue',
      'mock-sextant-coffee-roasters',
      '--guest',
      'new',
      '--scenario',
      'scenario.json',
    ])
    expect(result).toEqual({
      venue: 'mock-sextant-coffee-roasters',
      guest: 'new',
      scenario: 'scenario.json',
      out: null,
      force: false,
    })
  })

  it('requires --venue', () => {
    expect(parseGuestScenarioArgs([...BASE, '--guest', 'new', '--scenario', 'scenario.json'])).toBeNull()
  })

  it('requires --guest', () => {
    expect(parseGuestScenarioArgs([...BASE, '--venue', 'v', '--scenario', 'scenario.json'])).toBeNull()
  })

  it('requires --scenario', () => {
    expect(parseGuestScenarioArgs([...BASE, '--venue', 'v', '--guest', 'new'])).toBeNull()
  })

  it('rejects a --guest value outside the four synthetic states, including a bare phone number', () => {
    expect(
      parseGuestScenarioArgs([...BASE, '--venue', 'v', '--guest', '+15550001999', '--scenario', 's.json']),
    ).toBeNull()
    expect(
      parseGuestScenarioArgs([...BASE, '--venue', 'v', '--guest', 'regular_ish', '--scenario', 's.json']),
    ).toBeNull()
  })

  it('accepts each of the four canonical synthetic guest states', () => {
    for (const guest of ['new', 'returning', 'regular', 'raving_fan']) {
      const result = parseGuestScenarioArgs([...BASE, '--venue', 'v', '--guest', guest, '--scenario', 's.json'])
      expect(result?.guest).toBe(guest)
    }
  })

  it('accepts --out on its own', () => {
    const result = parseGuestScenarioArgs([
      ...BASE,
      '--venue',
      'v',
      '--guest',
      'new',
      '--scenario',
      's.json',
      '--out',
      '/tmp/run.jsonl',
    ])
    expect(result?.out).toBe('/tmp/run.jsonl')
    expect(result?.force).toBe(false)
  })

  it('accepts --force alongside --out', () => {
    const result = parseGuestScenarioArgs([
      ...BASE,
      '--venue',
      'v',
      '--guest',
      'new',
      '--scenario',
      's.json',
      '--out',
      '/tmp/run.jsonl',
      '--force',
    ])
    expect(result?.force).toBe(true)
  })

  it('rejects --force without --out', () => {
    expect(
      parseGuestScenarioArgs([...BASE, '--venue', 'v', '--guest', 'new', '--scenario', 's.json', '--force']),
    ).toBeNull()
  })

  it('rejects an unknown flag', () => {
    expect(
      parseGuestScenarioArgs([...BASE, '--venue', 'v', '--guest', 'new', '--scenario', 's.json', '--bogus']),
    ).toBeNull()
  })
})
