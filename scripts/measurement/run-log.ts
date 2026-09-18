/**
 * run-log.ts — TAC-426. Shared helper so a throwaway measurement harness
 * (a `scripts/sandbox/*.ts` script that makes many expensive AI calls to
 * measure something, e.g. "how often does a safety check actually catch a
 * real problem") gets safe-by-default output for free instead of
 * reimplementing it under time pressure.
 *
 * Filed after two independent instances of the same failure inside one
 * hour on 2026-09-16: `tac394-make-it-right-gate.ts` took its output path
 * as `process.argv[2] ?? 'tac394-make-it-right-gate.json'`, so two re-runs
 * without an explicit path silently overwrote a prior run's 60-reply
 * result set, and TAC-409's own replay prep script did the identical
 * thing — built an expensive fixture set, wrote once at the end, then
 * threw on an unrelated bad UUID and lost every generated body. Both
 * scripts were gitignored scratchpad (`scripts/sandbox/` is in
 * .gitignore) and are not being fixed here — see the CLAUDE.md entry this
 * module is documented under for the full incident and the four
 * properties it exists to give every future harness by default:
 *
 * 1. Timestamped output by default — the default path can never collide
 *    with a previous run's.
 * 2. Checkpoint as you go — JSON Lines, one line appended (and flushed)
 *    per unit, so a crash between two units loses nothing already on
 *    disk. There is no end-of-run write.
 * 3. Never silently overwrite an EXPLICIT path — refuse unless the caller
 *    passes `force: true`, mirroring `seed-venue`'s hard-refuse-then-
 *    `--force` shape (scripts/onboarding/seed-supabase.ts).
 * 4. Self-describing — the first line written is a header carrying the
 *    caller's `meta` (arm, prompt version, the constant under test, ...)
 *    plus the git SHA and a timestamp, readable with a plain JSON-Lines
 *    reader and no dependency on the script that wrote it.
 *
 * Prior art for the same failure in a different medium: TAC-347 Stage 4
 * hit "a single reused Sheets tab destroys the previous run's result set"
 * and fixed it with timestamped tab names + retention
 * (scripts/onboarding/tab-retention.ts). Different API (Sheets tabs vs.
 * local files), same idea — cited as a pointer, not reused as code.
 *
 * No I/O at module load. `now` and `gitSha` are injectable for tests.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RunLogMeta {
  // Which arm/variant of the thing under test produced this run — e.g.
  // "old_prompt" vs. "new_prompt", or a venue slug + scenario set. Required
  // so a result file is never ambiguous about what it measured.
  arm: string
  // Anything else worth freezing alongside the arm: prompt version
  // constants, the tunable under test, sample size, concurrency. TAC-409's
  // replay needed VERIFY_GROUNDING_PROMPT_VERSION here to tell its two
  // arms apart after the fact.
  [key: string]: unknown
}

export interface RunLogOptions {
  // Base name for the default timestamped path, e.g.
  // "tac394-make-it-right-gate". Ignored when outputPath is given.
  name: string
  // Explicit output path. Omit to get the timestamped default (property 1).
  // An explicit path that already exists is refused unless force is set
  // (property 3) — the default path is never refused; see resolvePath.
  outputPath?: string
  // Required to overwrite an EXPLICIT existing path. Has no effect on the
  // default path (nothing to force there — the default never collides).
  force?: boolean
  meta: RunLogMeta
  // Test injection points.
  now?: () => Date
  gitSha?: string | null
}

export interface RunLog {
  readonly path: string
  // Appends one unit and flushes immediately — this IS the checkpoint.
  // Call once per generated body / fixture / trial, not once at the end.
  appendUnit(unit: Record<string, unknown>): void
}

export interface RunLogHeader {
  __meta__: true
  arm: string
  generatedAt: string
  gitSha: string | null
  [key: string]: unknown
}

export interface RunLogContents {
  header: RunLogHeader
  units: Record<string, unknown>[]
}

function defaultGitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    // Not a git checkout, or git unavailable. A run log outside a repo is
    // still valid — the header just can't pin a code state.
    return null
  }
}

function isoForFilename(date: Date): string {
  // Colons and dots aren't safe across filesystems in a bare timestamp;
  // hyphens are. Matches the shape tab-retention.ts uses for the same
  // reason on Sheets tab names (which reject `:` outright).
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * The default output path for `name`, guaranteed never to collide with an
 * existing file: `${name}-<ISO-with-hyphens>.jsonl`, then a numeric suffix
 * (`-2`, `-3`, ...) if that exact path is already taken (two calls inside
 * the same process/test can land on the same millisecond). This needs no
 * `force` and no caller action — the default must never be allowed to
 * collide, full stop.
 */
function resolveDefaultPath(name: string, date: Date): string {
  const base = `${name}-${isoForFilename(date)}`
  let path = `${base}.jsonl`
  let n = 2
  while (existsSync(path)) {
    path = `${base}-${n}.jsonl`
    n += 1
  }
  return path
}

export function createRunLog(options: RunLogOptions): RunLog {
  const now = options.now ?? (() => new Date())
  const gitSha = options.gitSha !== undefined ? options.gitSha : defaultGitSha()
  const generatedAt = now()

  let path: string
  if (options.outputPath === undefined) {
    path = resolveDefaultPath(options.name, generatedAt)
  } else {
    path = options.outputPath
    if (existsSync(path) && !options.force) {
      throw new Error(
        [
          `run-log: output path "${path}" already exists.`,
          ``,
          `Re-run with an unset outputPath to get a fresh timestamped file,`,
          `or pass force: true to overwrite this one. A measurement harness`,
          `must never silently destroy a previous run's results — see`,
          `TAC-426 and the CLAUDE.md "Measurement harness convention" entry.`,
        ].join('\n'),
      )
    }
  }

  const dir = dirname(path)
  if (dir && dir !== '.') {
    mkdirSync(dir, { recursive: true })
  }

  const header: RunLogHeader = {
    ...options.meta,
    __meta__: true,
    arm: options.meta.arm,
    generatedAt: generatedAt.toISOString(),
    gitSha,
  }
  // truncate-and-start-fresh: an explicit force overwrite, or a brand-new
  // default path, both start from an empty file with just the header line.
  writeFileSync(path, `${JSON.stringify(header)}\n`)

  return {
    path,
    appendUnit(unit: Record<string, unknown>) {
      appendFileSync(path, `${JSON.stringify(unit)}\n`)
    },
  }
}

export function readRunLog(path: string): RunLogContents {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    throw new Error(`run-log: "${path}" has no header line`)
  }
  const header = JSON.parse(lines[0]) as RunLogHeader
  const units = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>)
  return { header, units }
}
