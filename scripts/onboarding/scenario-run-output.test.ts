import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendResult, defaultOutputPath, refuseExistingUnlessForced, writeHeader } from './scenario-run-output'

describe('defaultOutputPath', () => {
  it('is unique given two different `now` values', () => {
    const a = defaultOutputPath(new Date('2026-09-18T12:00:00.001Z'))
    const b = defaultOutputPath(new Date('2026-09-18T12:00:00.002Z'))
    expect(a).not.toBe(b)
  })

  it('is filesystem-safe (no colons) and lives under scenario-runs/', () => {
    const path = defaultOutputPath(new Date('2026-09-18T12:00:00.000Z'))
    expect(path).toMatch(/^scripts\/onboarding\/scenario-runs\/run-.+\.jsonl$/)
    expect(path).not.toContain(':')
  })
})

describe('refuseExistingUnlessForced / writeHeader / appendResult', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scenario-run-output-'))
    path = join(dir, 'run.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not throw when the path does not exist', () => {
    expect(() => refuseExistingUnlessForced(path, false)).not.toThrow()
  })

  it('throws without --force when the path already exists', () => {
    writeFileSync(path, 'x')
    expect(() => refuseExistingUnlessForced(path, false)).toThrow(/refusing to overwrite/)
  })

  it('does not throw with --force even when the path exists', () => {
    writeFileSync(path, 'x')
    expect(() => refuseExistingUnlessForced(path, true)).not.toThrow()
  })

  it('writeHeader creates the file (and parent dir) with the header as the first line', () => {
    const nestedPath = join(dir, 'nested', 'run.jsonl')
    const header = {
      promptVersion: 'v1.52.0',
      gitSha: 'abc1234',
      model: 'claude-sonnet-4-6',
      generatedAt: '2026-09-18T12:00:00.000Z',
      venueSlug: 'mock-sextant-coffee-roasters',
      guestState: 'new' as const,
    }
    writeHeader(nestedPath, header)
    expect(existsSync(nestedPath)).toBe(true)
    const lines = readFileSync(nestedPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ kind: 'header', ...header })
  })

  it('appendResult after writeHeader produces valid JSON-Lines readable line-by-line, and a partial run (crash after N units) leaves exactly N result rows', () => {
    writeHeader(path, {
      promptVersion: 'v1.52.0',
      gitSha: 'abc1234',
      model: 'claude-sonnet-4-6',
      generatedAt: '2026-09-18T12:00:00.000Z',
      venueSlug: 'mock-sextant-coffee-roasters',
      guestState: 'new',
    })
    appendResult(path, { sampleId: 'one', outcome: 'sent' })
    appendResult(path, { sampleId: 'two', outcome: 'queued' })
    // Simulate a crash: never called for a hypothetical "three".

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3) // header + 2 results
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].kind).toBe('header')
    expect(parsed[1]).toEqual({ kind: 'result', sampleId: 'one', outcome: 'sent' })
    expect(parsed[2]).toEqual({ kind: 'result', sampleId: 'two', outcome: 'queued' })
  })
})
