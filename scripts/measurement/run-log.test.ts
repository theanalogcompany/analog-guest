import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLog, readRunLog, RUN_LOG_DIR } from './run-log'

// Real filesystem, real temp dir — not a mocked `fs`. A fake answers only
// the arguments it was written for (same reasoning CLAUDE.md gives for
// run-report.mjs's real-git-repo test and claims.test.ts's real fixtures).
//
// EVERY test runs with the working directory inside its own temp dir, because
// the default path is resolved relative to it. Until 2026-09-20 these tests
// instead passed an ABSOLUTE PATH as the run's `name` to steer the old
// CWD-relative default into a temp dir — a trick that silently stopped working
// when the default moved into RUN_LOG_DIR (`join('measurement-runs', '/var/…')`
// rebuilt a `/var/folders/…` tree inside the checkout). `name` is a name now,
// and a path there is refused; where the file goes is `outputPath`'s job.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-log-test-'))
  process.chdir(dir)
})

afterEach(() => {
  // Back out before removing, or the process is left in a deleted directory
  // and every later test's relative path resolves against nothing.
  process.chdir(tmpdir())
  rmSync(dir, { recursive: true, force: true })
})

describe('createRunLog default path', () => {
  // Until 2026-09-20 a default-path run wrote to the working directory, so a
  // run started from the repo root dropped its JSONL beside package.json, and
  // several did before anyone noticed. A run log is evidence for a ticket, not
  // source, and it belongs somewhere findable and out of the way.
  it('writes into the run-log directory, never the working directory', () => {
    const log = createRunLog({ name: 'probe', meta: { arm: 'a' }, gitSha: null })
    expect(log.path.startsWith(`${RUN_LOG_DIR}/`)).toBe(true)
    expect(existsSync(log.path)).toBe(true)
    // The thing that regressed: nothing named `probe-*.jsonl` at the top level.
    expect(readdirSync('.').filter((f) => f.endsWith('.jsonl'))).toEqual([])
  })

  it('creates the run-log directory when it does not exist', () => {
    expect(existsSync(RUN_LOG_DIR)).toBe(false)
    const log = createRunLog({ name: 'probe', meta: { arm: 'a' }, gitSha: null })
    expect(existsSync(RUN_LOG_DIR)).toBe(true)
    expect(existsSync(log.path)).toBe(true)
  })

  // A name carrying a separator would escape the directory the default exists
  // to keep runs inside — and not to the absolute path the caller meant, but
  // to a mirrored tree under the working directory. This repo's own tests did
  // that for months, so the rejection is the guard that keeps RUN_LOG_DIR true.
  it.each(['/tmp/harness', 'nested/harness', '../harness'])(
    'refuses a name that is a path (%j) and names outputPath instead',
    (name) => {
      expect(() => createRunLog({ name, meta: { arm: 'a' }, gitSha: null })).toThrow(
        /name must be a run name, not a path/,
      )
      expect(() => createRunLog({ name, meta: { arm: 'a' }, gitSha: null })).toThrow(/outputPath/)
      // And nothing was created on the way to the throw.
      expect(existsSync(RUN_LOG_DIR)).toBe(false)
    },
  )

  // An explicit path is still honoured verbatim, so a caller that wants the
  // file somewhere specific is not silently redirected.
  it('leaves an explicit outputPath exactly where the caller put it', () => {
    const log = createRunLog({
      name: 'probe',
      outputPath: 'chosen.jsonl',
      meta: { arm: 'a' },
      gitSha: null,
    })
    expect(log.path).toBe('chosen.jsonl')
    expect(existsSync('chosen.jsonl')).toBe(true)
  })

  it('two runs with no explicit path both survive', () => {
    const tick = new Date('2026-09-18T10:00:00.000Z')
    const now = () => tick

    const first = createRunLog({
      name: 'harness',
      meta: { arm: 'old_prompt' },
      now,
      gitSha: 'sha-1',
    })
    first.appendUnit({ i: 1 })

    // Same millisecond as the first call — the numeric-suffix path must
    // still avoid collision without any caller action.
    const second = createRunLog({
      name: 'harness',
      meta: { arm: 'new_prompt' },
      now,
      gitSha: 'sha-2',
    })
    second.appendUnit({ i: 2 })

    expect(first.path).not.toBe(second.path)
    expect(existsSync(first.path)).toBe(true)
    expect(existsSync(second.path)).toBe(true)

    const firstContents = readRunLog(first.path)
    const secondContents = readRunLog(second.path)
    expect(firstContents.header.arm).toBe('old_prompt')
    expect(firstContents.units).toEqual([{ i: 1 }])
    expect(secondContents.header.arm).toBe('new_prompt')
    expect(secondContents.units).toEqual([{ i: 2 }])
  })

  it('advances the timestamp between calls to produce distinct default names', () => {
    const times = [new Date('2026-09-18T10:00:00.000Z'), new Date('2026-09-18T10:05:00.000Z')]
    let i = 0
    const now = () => times[i++]

    const first = createRunLog({ name: 'harness', meta: { arm: 'a' }, now, gitSha: null })
    const second = createRunLog({ name: 'harness', meta: { arm: 'b' }, now, gitSha: null })

    expect(first.path).toContain('2026-09-18T10-00-00')
    expect(second.path).toContain('2026-09-18T10-05-00')
  })
})

describe('checkpoint as you go', () => {
  it('a run killed mid-way leaves every completed unit intact and readable', () => {
    const log = createRunLog({
      name: 'harness',
      meta: { arm: 'old_prompt', promptVersion: 'v1.3.0' },
      now: () => new Date('2026-09-18T10:00:00.000Z'),
      gitSha: 'deadbeef',
    })

    log.appendUnit({ id: 1, body: 'first generated body' })
    log.appendUnit({ id: 2, body: 'second generated body' })

    // Simulate the crash both real incidents hit: a throw after some units
    // are done and before the run finishes. There is no end-of-run write
    // for this to interrupt — appendUnit already flushed both lines.
    let crashed = false
    try {
      log.appendUnit({ id: 3, body: 'about to throw' })
      throw new Error('unrelated bad UUID')
    } catch {
      crashed = true
    }
    expect(crashed).toBe(true)

    const contents = readRunLog(log.path)
    expect(contents.units).toEqual([
      { id: 1, body: 'first generated body' },
      { id: 2, body: 'second generated body' },
      { id: 3, body: 'about to throw' },
    ])
  })

  it('a header-only file (crash before any unit) is still valid and readable', () => {
    const log = createRunLog({
      name: 'harness',
      meta: { arm: 'x' },
      now: () => new Date('2026-09-18T10:00:00.000Z'),
      gitSha: null,
    })
    expect(log.path).toBeTruthy()

    const contents = readRunLog(log.path)
    expect(contents.units).toEqual([])
    expect(contents.header.arm).toBe('x')
  })
})

describe('explicit path collision', () => {
  it('refuses to overwrite an explicit existing path without force', () => {
    const path = join(process.cwd(), 'explicit-results.jsonl')

    const log = createRunLog({ name: 'unused', outputPath: path, meta: { arm: 'a' }, gitSha: null })
    log.appendUnit({ i: 1 })

    expect(() =>
      createRunLog({ name: 'unused', outputPath: path, meta: { arm: 'b' }, gitSha: null }),
    ).toThrow(/already exists/)

    // The refused attempt must not have touched the existing file.
    const contents = readRunLog(path)
    expect(contents.header.arm).toBe('a')
    expect(contents.units).toEqual([{ i: 1 }])
  })

  it('overwrites an explicit existing path when force is true', () => {
    const path = join(process.cwd(), 'explicit-results.jsonl')

    const first = createRunLog({ name: 'unused', outputPath: path, meta: { arm: 'a' }, gitSha: null })
    first.appendUnit({ i: 1 })

    const second = createRunLog({
      name: 'unused',
      outputPath: path,
      meta: { arm: 'b' },
      gitSha: null,
      force: true,
    })
    second.appendUnit({ i: 2 })

    const contents = readRunLog(path)
    expect(contents.header.arm).toBe('b')
    expect(contents.units).toEqual([{ i: 2 }])
  })
})

describe('header round-trip', () => {
  it('meta, git sha and generatedAt all come back without the writer script', () => {
    const log = createRunLog({
      name: 'harness',
      meta: { arm: 'new_prompt', promptVersion: 'v1.4.0', sampleSize: 39 },
      now: () => new Date('2026-09-18T10:00:00.000Z'),
      gitSha: 'cafef00d',
    })

    const contents = readRunLog(log.path)
    expect(contents.header).toMatchObject({
      __meta__: true,
      arm: 'new_prompt',
      promptVersion: 'v1.4.0',
      sampleSize: 39,
      gitSha: 'cafef00d',
      generatedAt: '2026-09-18T10:00:00.000Z',
    })
  })
})

describe('directory auto-creation', () => {
  it('creates a not-yet-existing subdirectory named by outputPath', () => {
    const path = join(process.cwd(), 'results', 'nested', 'run.jsonl')

    const log = createRunLog({ name: 'unused', outputPath: path, meta: { arm: 'a' }, gitSha: null })
    log.appendUnit({ i: 1 })

    expect(existsSync(path)).toBe(true)
  })
})

describe('real git sha default', () => {
  it('resolves a string or null when gitSha is not injected', () => {
    const log = createRunLog({ name: 'harness', meta: { arm: 'a' } })
    const contents = readRunLog(log.path)
    expect(typeof contents.header.gitSha === 'string' || contents.header.gitSha === null).toBe(true)
  })
})
