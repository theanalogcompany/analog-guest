import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkNodeVersion } from './vitest.node-version'

// The guard runs as globalSetup, so if it were wrong it would either fail every
// run or protect nothing. Its comparison is pure precisely so it can be checked
// here without spawning another Node.

describe('checkNodeVersion', () => {
  it('passes when the majors agree', () => {
    expect(checkNodeVersion('v24.13.0', '24\n')).toBeNull()
  })

  it('ignores the minor and patch', () => {
    // The whole point of comparing majors only: a developer whose nvm is a
    // fortnight stale must not be blocked, because the failures this guards
    // against are major-version behaviour differences.
    expect(checkNodeVersion('v24.0.1', '24\n')).toBeNull()
    expect(checkNodeVersion('v24.99.99', '24\n')).toBeNull()
  })

  it('tolerates a leading v and surrounding whitespace in .nvmrc', () => {
    expect(checkNodeVersion('v24.13.0', ' v24 \n')).toBeNull()
  })

  it('accepts a fully-specified .nvmrc', () => {
    expect(checkNodeVersion('v24.13.0', '24.13.0')).toBeNull()
  })

  it('fails on a different major, and says how to fix it', () => {
    const problem = checkNodeVersion('v20.11.0', '24\n')
    expect(problem).not.toBeNull()
    expect(problem).toContain('running v20')
    expect(problem).toContain('.nvmrc wants v24')
    // The message has to carry the remedy. A guard that only says "wrong
    // version" sends the reader to search for which one is right.
    expect(problem).toContain('nvm use')
  })

  it('reports rather than silently passing when .nvmrc is empty', () => {
    // A missing or blank .nvmrc must not read as "any version is fine" — that
    // is the state this guard was added to end.
    expect(checkNodeVersion('v24.13.0', '')).toContain('Could not compare')
    expect(checkNodeVersion('v24.13.0', '   \n')).toContain('Could not compare')
  })

  it('agrees with the .nvmrc actually committed, on the Node actually running', () => {
    // The end-to-end case. If this fails, either the file is malformed or you
    // are on the wrong Node — and the globalSetup will already have said so.
    const nvmrc = readFileSync(join(__dirname, '.nvmrc'), 'utf8')
    expect(checkNodeVersion(process.version, nvmrc)).toBeNull()
  })
})
