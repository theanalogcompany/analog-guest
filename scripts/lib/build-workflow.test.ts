import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claimRun } from './claims.mjs'
import { commentMarker } from './comment-provenance.mjs'
import { checkCommentBody } from './linear-cli.mjs'
import { ENDING } from './run-report.mjs'

// Nothing runs a workflow under test, so these read the files as text, like
// linear-prompts.test.ts does. What they guard (TAC-447): one ticket per
// run, one turn limit read in one place, the turn-limit notices wired to
// the script that writes them, and the new markers agreeing with every list
// that routes on markers. TAC-448 adds the claim check, and runs the
// selection's own jq against a fixture: a jq program nobody runs is not
// tested by reading it.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

const WORKFLOW = read('.github/workflows/build-ready.yml')

// The text between two markers that must each appear exactly once.
function between(text: string, start: string, end: string) {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0 || text.indexOf(start, from + 1) >= 0) {
    throw new Error(`"${start}" … "${end}" moved`)
  }
  return text.slice(from, to)
}

// A step's `run: |` block, as the runner sees it: the common indent removed.
function runBlock(stepName: string) {
  const step = WORKFLOW.slice(WORKFLOW.indexOf(`- name: ${stepName}`))
  const lines = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length).split('\n')
  const indent = lines[0].match(/^ */)![0]
  const body: string[] = []
  for (const line of lines) {
    if (line.trim() !== '' && !line.startsWith(indent)) break
    body.push(line.slice(indent.length))
  }
  return body.join('\n')
}

const INPUTS = between(WORKFLOW, '  workflow_dispatch:', 'concurrency:')
const PROMPT = between(WORKFLOW, 'prompt: |', '- name: Check the session posted')
const QUEUE = runBlock('Find tickets to work')
const SNAPSHOT = runBlock('Keep a copy of the turn-limit reporter')
const CHECK = runBlock('Check the session posted on every ticket it worked')

// Bookkeeping: posted by a workflow, never the newest comment on a ticket.
const BOOKKEEPING = ['CLAIM', 'DENIALS', 'OVER-LIMIT', 'RESUME-CLAIM', 'SLACK']
// Posted by the workflow after a session, so never the session's own comment.
const WORKFLOW_NOTICES = [...BOOKKEEPING, 'SILENT-RUN', 'TURN-LIMIT'].sort()

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()
// Every [MARKER] named in a stretch of prose.
const markersIn = (text: string) => sorted([...text.matchAll(/\[([A-Z][A-Z-]*)\]/g)].map((m) => m[1]))
// The alternation inside marker_is("...") or \[(?:...)\].
const alternation = (text: string, pattern: RegExp) => {
  const m = text.match(pattern)
  if (!m) throw new Error(`no match for ${pattern}`)
  return sorted(m[1].split('|'))
}

describe('build-ready.yml selects one ticket per run', () => {
  it('limits the queue to one ticket', () => {
    expect(WORKFLOW).toContain('          LIMIT: "1"\n')
    expect(WORKFLOW).not.toMatch(/LIMIT: "[02-9]/)
  })

  it('tells the session it has one ticket', () => {
    expect(PROMPT).toContain('Ticket: ${{ steps.queue.outputs.tickets }}')
    expect(PROMPT).not.toMatch(/Tickets, in order/)
    expect(PROMPT).not.toMatch(/next ticket/)
  })
})

describe('build-ready.yml skips a ticket another session has (TAC-448)', () => {
  it('is valid bash', () => {
    const r = spawnSync('bash', ['-n'], { input: QUEUE, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('runs the claim check on every candidate before taking LIMIT', () => {
    expect(QUEUE).toContain('SELECTED=$(echo "$CANDIDATES" | node scripts/claims.mjs)')
    // Cutting the list in jq would take a claimed ticket and then skip it,
    // leaving the run with nothing while the next ticket waits. Any
    // spelling of the cut: a slice, limit(), [first], [first(...)] or
    // [.[0]]. A first() inside an expression is not a cut and is not refused.
    const program = between(QUEUE, 'CANDIDATES=$(', 'SELECTED=$(echo')
    expect(program).not.toMatch(/\.\[\s*-?\d*\s*:|\blimit\s*\(|\[\s*first\s*[\](]|\[\s*\.\[\s*0\s*\]\s*\]|\$limit/)
    expect(QUEUE.indexOf('node scripts/claims.mjs')).toBeLessThan(QUEUE.indexOf('TICKETS=$('))
  })

  it('leaves liveness to the claim check alone', () => {
    // A second liveness rule in jq (createdAt, start only) is how the resume
    // path went unchecked: two rules, and only one of them was ever read.
    expect(between(QUEUE, 'CANDIDATES=$(', "SELECTED=$(echo")).not.toContain('POLLING-STATE')
    expect(QUEUE).not.toMatch(/\.live\b/)
  })

  it('reads when each comment was last edited, which is how a claim stays live', () => {
    expect(QUEUE).toContain('comments(first: 250) { nodes { id body createdAt updatedAt } }')
  })

  it('gives the check a token to list open PRs, and the live window', () => {
    const env = between(WORKFLOW, '      - name: Find tickets to work', '        run: |')
    expect(env).toContain('GH_TOKEN: ${{ github.token }}')
    expect(env).toContain('LIVE_SESSION_HOURS: "3"')
  })

  it('claims every ticket it takes, naming its run, before the session starts', () => {
    const loop = between(QUEUE, '# Claim every ticket before Claude runs.', 'echo "claimed $NAME"')
    expect(loop).toContain(`echo "$SELECTED" | jq -c '.[]' | while read -r row; do`)
    expect(loop).toContain('MARK="[RESUME-CLAIM] ruling=$(echo "$row" | jq -r .newestId) run=${GITHUB_RUN_ID}"')
    expect(loop).toContain('MARK="[CLAIM] ${NAME} run=${GITHUB_RUN_ID}"')
    expect(QUEUE.indexOf('# Claim every ticket')).toBeGreaterThan(QUEUE.indexOf('if [ "${DRY_RUN:-false}" = "true" ]; then\n  echo "Dry run: no claims'))
  })

  it('tells the session not to post a claim of its own', () => {
    expect(PROMPT).toContain('you post no [CLAIM] of your own')
  })

  it('checks out every branch, which is where the commit signal comes from', () => {
    // A shallow checkout of main lists only main: every commit signal would
    // vanish without a word, and claims.mjs cannot tell. This pin is what
    // protects the scheduled run.
    expect(between(WORKFLOW, '      - uses: actions/checkout@v6', '      - uses: actions/setup-node')).toContain('fetch-depth: 0')
  })

  it('claims a ticket named in a dispatch, which skips the selection, but not on a dry run', () => {
    const named = between(QUEUE, 'if [ -n "${ONE_TICKET:-}" ]; then', '  exit 0\nfi')
    const dry = between(named, 'if [ "${DRY_RUN:-false}" = "true" ]; then', 'else')
    expect(dry).not.toContain('linear.mjs')
    expect(named).toContain('node scripts/linear.mjs comment "$NAMED" "$RUNNER_TEMP/claim-$NAMED.md"')
    expect(named.indexOf('linear.mjs comment')).toBeLessThan(named.indexOf('echo "tickets=$ONE_TICKET"'))
    // The body printf writes is one the helper accepts, and reads back as
    // the build workflow's own claim.
    const format = named.match(/printf '([^']+)' "\$NAMED" "\$GITHUB_RUN_ID"/)?.[1]
    if (!format) throw new Error('the claim printf moved')
    const body = format.replace('%s', 'TAC-403').replace('%s', '35299836324').replaceAll('\\n', '\n')
    expect(checkCommentBody(body)).toEqual({ ok: true })
    expect(commentMarker(body)).toBe('CLAIM')
    expect(claimRun(body)).toBe('35299836324')
  })

  describe("the selection's jq, run on a fixture", () => {
    // TAC-396 on 2026-09-18: Needs Action, Jaipal's 01:33 ruling, then a
    // local session's [CLAIM]. The claim must not bury the ruling, or the
    // ticket stops being a candidate and the log never says why.
    // The program is RULES followed by the text between the "$RULES"' that
    // opens the CANDIDATES jq and the ') that closes it, so a new --arg on
    // that jq does not move the anchor.
    const rules = QUEUE.slice(QUEUE.indexOf("RULES='") + "RULES='".length, QUEUE.indexOf("'\n\n", QUEUE.indexOf("RULES='")))
    const open = QUEUE.indexOf(`"$RULES"'`, QUEUE.indexOf('CANDIDATES=$(')) + `"$RULES"'`.length
    const program = rules + QUEUE.slice(open, QUEUE.indexOf("\n')", open))
    // Times relative to now: the claim check reads the real clock, and a
    // fixture pinned to a date stops being live three hours after it.
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const RULING_AT = ago(60)
    const comment = (id: string, body: string, createdAt: string) => ({ id, body, createdAt, updatedAt: createdAt })
    const issue = (identifier: string, state: string, labels: string[], comments: object[], priority = 2) => ({
      id: `uuid-${identifier}`,
      identifier,
      description: '**Repo:** `analog-guest`.',
      priority,
      state: { name: state },
      labels: { nodes: [{ name: 'analog-guest' }, ...labels.map((name) => ({ name }))] },
      comments: { nodes: comments },
    })
    const response = {
      data: {
        issues: {
          nodes: [
            issue('TAC-396', 'In Progress', ['Needs Action'], [
              comment('55ebb992', '**[FROM CLAUDE CODE]**\n\n[NEEDS-ACTION] TAC-396', ago(120)),
              // Edited after the claim: the ruling's time is when it landed.
              { ...comment('55bea2c5', '**[FROM CLAUDE CHAT — RULING]**\n\n**Reopening.**', RULING_AT), updatedAt: ago(10) },
              comment('c1', '**[FROM CLAUDE CODE]**\n\n[CLAIM] TAC-396 session=local', ago(30)),
            ]),
            issue('TAC-448', 'Ready', [], [], 1),
          ],
        },
      },
    }

    function candidates(pendingIds: string[] = []) {
      const r = spawnSync(
        'jq',
        ['-c', '--arg', 'repo', 'analog-guest', '--argjson', 'maxAttempts', '2', '--argjson', 'pendingIds', JSON.stringify(pendingIds), program],
        { input: JSON.stringify(response), encoding: 'utf8' },
      )
      expect(r.stderr).toBe('')
      return JSON.parse(r.stdout)
    }

    it('carries no apostrophe, which would close the shell quote around it', () => {
      // bash -n catches one stray apostrophe but not two: a pair reopens the
      // quote and the step runs a different program than the one written.
      expect(program).not.toContain("'")
      expect(program).toContain('def owner:')
      expect(program).toContain('sort_by(if .priority == 0 then 99 else .priority end)')
    })

    it('keeps a claimed resume as a candidate, with the ruling it would act on', () => {
      const c = candidates()
      expect(c.map((x: { identifier: string; mode: string }) => `${x.identifier}:${x.mode}`)).toEqual(['TAC-448:start', 'TAC-396:resume'])
      const resume = c[1]
      expect(resume.newestId).toBe('55bea2c5')
      expect(resume.newestAt).toBe(RULING_AT)
      // The claim check reads the claims from here.
      expect(resume.comments).toHaveLength(3)
    })

    // TAC-453: a Ready, unblocked candidate whose thread still asks a
    // question nothing answered must never become "start" — mutation-style,
    // run against the SAME fixture and the SAME extracted jq program, so an
    // empty pendingIds proves the clause is load-bearing rather than
    // decorative (it selects TAC-448 either way; only $pendingIds decides
    // whether it does).
    it('excludes a Ready, unblocked candidate named in $pendingIds from "start"', () => {
      expect(candidates(['TAC-448']).map((x: { identifier: string }) => x.identifier)).not.toContain('TAC-448')
    })

    it('selects the same candidate when $pendingIds is empty', () => {
      expect(candidates([]).map((x: { identifier: string }) => x.identifier)).toContain('TAC-448')
    })

    it('hands the claim check what it needs, and the claim check skips TAC-396', () => {
      const dir = mkdtempSync(join(tmpdir(), 'queue-claims-'))
      try {
        // Inside the pre-commit hook git exports GIT_DIR and GIT_INDEX_FILE,
        // which would point both git and the check at this repository, so
        // every GIT_ variable goes. gh gets an empty config and no token, so
        // it fails at once instead of calling GitHub from a unit test.
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, GH_CONFIG_DIR: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
        for (const key of Object.keys(env)) {
          if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG_')) delete env[key]
        }
        for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_REPOSITORY']) delete env[key]
        // Only main on GitHub, so only the comment can claim anything.
        const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
        git('init', '-q')
        git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x')
        git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        const onlyResume = candidates().filter((x: { mode: string }) => x.mode === 'resume')
        const r = spawnSync('node', [resolve(ROOT, 'scripts/claims.mjs')], {
          cwd: dir,
          input: JSON.stringify(onlyResume),
          encoding: 'utf8',
          env: { ...env, LIMIT: '1' },
        })
        expect(r.status, r.stderr).toBe(0)
        expect(JSON.parse(r.stdout)).toEqual([])
        expect(r.stderr).toContain("skipped TAC-396 (resume, In Progress): another session has it: a local session's [CLAIM]")
        // gh could not list PRs, and the check carried on without them.
        expect(r.stderr).toContain('::warning title=Claim check::Could not list open PRs.')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('build-ready.yml refuses to start a ticket still waiting on an answer (TAC-453)', () => {
  const PENDING_BLOCK = between(QUEUE, 'PENDING=$(echo "$RESPONSE"', '\n\n# Every candidate')
  const LABEL_DRIFT = runBlock('Flag tickets whose blocking label was cleared without an answer')

  it('runs before CANDIDATES decides mode', () => {
    expect(QUEUE.indexOf('PENDING=$(echo "$RESPONSE"')).toBeLessThan(QUEUE.indexOf('CANDIDATES=$('))
  })

  it('runs after the ONE_TICKET dispatch early exit, which skips the selection entirely', () => {
    const named = between(QUEUE, 'if [ -n "${ONE_TICKET:-}" ]; then', '  exit 0\nfi')
    expect(named).not.toContain('PENDING')
  })

  it('never aborts the step: both reads that can fail have a fallback', () => {
    // The candidate jq AND the pending-question script each need their own
    // `|| echo '[]'` under `set -euo pipefail` — a fallback on only one
    // leaves the other free to abort the step and skip tickets=$TICKETS,
    // the same MAJOR the TAC-466 reconcile block guards against below.
    expect(PENDING_BLOCK.match(/\|\| echo '\[\]'/g)).toHaveLength(2)
    expect(PENDING_BLOCK).toContain('node scripts/pending-question.mjs')
  })

  it('checks exactly the population CANDIDATES would otherwise call "start"', () => {
    expect(PENDING_BLOCK).toContain('select(.state.name == "Ready"')
    expect(PENDING_BLOCK).toContain('has_label("Needs Decision") or has_label("Needs Action")')
    expect(PENDING_BLOCK).toContain('select(owner == $repo and (repo_labels | length) == 1)')
  })

  it('hands $pendingIds into the mode jq, and mode excludes anything named in it', () => {
    expect(QUEUE).toContain(`--argjson pendingIds "$(echo "$PENDING" | jq -c 'map(.identifier)')"`)
    const mode = between(QUEUE, 'if .state.name == "Ready" and (.blocked | not)', 'sort_by(if .priority')
    expect(mode).toContain('$pendingIds')
  })

  it('carries no apostrophe in the jq program text it adds, which would close the shell quote', () => {
    const open = PENDING_BLOCK.indexOf(`"$RULES"'`) + `"$RULES"'`.length
    const jqBody = PENDING_BLOCK.slice(open, PENDING_BLOCK.indexOf("\n'", open))
    expect(jqBody).not.toContain("'")
    expect(jqBody).toContain('.data.issues.nodes')
  })

  it('forces pending=[] on both early exits: the named-ticket dispatch and dry run', () => {
    const named = between(QUEUE, 'if [ -n "${ONE_TICKET:-}" ]; then', '  exit 0\nfi')
    expect(named).toContain('echo "pending=[]" >> "$GITHUB_OUTPUT"')
    const dry = between(QUEUE, 'if [ "${DRY_RUN:-false}" = "true" ]; then\n  echo "Dry run: no claims', 'exit 0\nfi')
    expect(dry).toContain('echo "pending=[]" >> "$GITHUB_OUTPUT"')
  })

  it('prints a restore: line and writes pending= for the real run', () => {
    expect(QUEUE).toContain(`echo "$PENDING" | jq -r '.[] | "restore: \\(.identifier) (\\(.label))"'`)
    expect(QUEUE).toContain('echo "pending=$PENDING" >> "$GITHUB_OUTPUT"')
    // Printed and written before the dry-run exit, so `-f dry_run=true`
    // shows what this would restore without writing anything.
    expect(QUEUE.indexOf('restore:')).toBeLessThan(QUEUE.indexOf('if [ "${DRY_RUN:-false}" = "true" ]; then\n  echo "Dry run: no claims'))
  })

  describe('the flag step', () => {
    it('is valid bash', () => {
      const r = spawnSync('bash', ['-n'], { input: LABEL_DRIFT, encoding: 'utf8' })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    })

    it('only runs when the queue step found something pending', () => {
      const step = between(WORKFLOW, '- name: Flag tickets whose blocking label was cleared without an answer', 'run: |')
      expect(step).toContain("if: steps.queue.outputs.pending != '' && steps.queue.outputs.pending != '[]'")
    })

    it('posts [LABEL-DRIFT] naming the ticket, and restores the label the row names', () => {
      expect(LABEL_DRIFT).toContain('[LABEL-DRIFT] ${NAME}')
      expect(LABEL_DRIFT).toContain('label was gone')
      expect(LABEL_DRIFT).toContain('label_id "Needs Decision"')
      expect(LABEL_DRIFT).toContain('label_id "Needs Action"')
    })

    it('restores Needs Action when the row says Needs Action, Needs Decision otherwise', () => {
      const loop = between(LABEL_DRIFT, "echo \"$PENDING\" | jq -c '.[]'", 'done')
      expect(loop).toContain('if [ "$LABEL" = "Needs Action" ]; then')
      expect(loop).toContain('LABEL_ID="$NEEDS_ACTION_ID"')
      expect(loop).toContain('LABEL_ID="$NEEDS_DECISION_ID"')
    })
  })

  it('the header states the interaction with TAC-446: which mechanism owns what', () => {
    const header = WORKFLOW.slice(0, WORKFLOW.indexOf('\non:\n'))
    expect(header).toContain('TAC-453')
    expect(header).toContain('TAC-446')
    expect(header).toContain('cannot un-select a ticket this run already chose')
  })
})

describe('build-ready.yml reconciles ticket status from GitHub state (TAC-466)', () => {
  // "$STATUS_CANDIDATES" would collide as a `between()` anchor: it contains
  // "CANDIDATES=$(" as a substring, the same anchor TAC-448's own tests use,
  // so the workflow names this STATUS_ROWS instead. This test pins that the
  // avoidance holds, since a future rename back would silently break both
  // this describe block and the TAC-448 one above it.
  const RECONCILE = between(QUEUE, 'STATUS_ROWS=$(', 'echo "tickets=$TICKETS"')

  it('runs after the claim check and after the dry-run exit, never before', () => {
    const at = QUEUE.indexOf('STATUS_ROWS=$(')
    expect(at).toBeGreaterThan(QUEUE.indexOf('SELECTED=$(echo "$CANDIDATES" | node scripts/claims.mjs)'))
    expect(at).toBeGreaterThan(QUEUE.indexOf('if [ "${DRY_RUN:-false}" = "true" ]; then\n  echo "Dry run: no claims'))
  })

  it('runs before tickets= reaches GITHUB_OUTPUT, so a failure here cannot skip it', () => {
    expect(QUEUE.indexOf('STATUS_ROWS=$(')).toBeLessThan(QUEUE.indexOf('echo "tickets=$TICKETS" >> "$GITHUB_OUTPUT"'))
  })

  it('reconciles every owner-matched candidate, not just what the claim check selected this run', () => {
    expect(RECONCILE).not.toContain('$SELECTED')
    expect(RECONCILE).toContain('select(owner == $repo and (repo_labels | length) == 1)')
  })

  it('hands the candidates to the reconcile script and writes only what it returns, never a literal status', () => {
    expect(RECONCILE).toContain('node scripts/reconcile-status.mjs')
    expect(RECONCILE).toContain('node scripts/linear.mjs state "$IDENTIFIER" "$TO"')
    // Every status name this block could write comes from $TO; it never
    // spells one out, which is what stops a third value creeping in here
    // without also going through deriveTargetStatus's own guard.
    expect(RECONCILE).not.toMatch(/"(Ready|In Progress|Ready For QA|Done|Todo|Backlog)"/)
  })

  it('never aborts the step: both reads that can fail have a fallback, and the write is if/else', () => {
    // Two, not one: the candidate jq AND the reconcile-script call each need
    // their own `|| echo '[]'` under `set -euo pipefail` — a fallback on
    // only one leaves the other free to abort the step and skip
    // tickets=$TICKETS below it, which is exactly the MAJOR this pins.
    expect(RECONCILE.match(/\|\| echo '\[\]'/g)).toHaveLength(2)
    expect(RECONCILE).toContain('if node scripts/linear.mjs state "$IDENTIFIER" "$TO"; then')
    expect(RECONCILE).toContain('::warning title=Status reconcile::')
  })

  it('the header documents it as a projection, never a claim', () => {
    const header = WORKFLOW.slice(0, WORKFLOW.indexOf('\non:\n'))
    expect(header).toContain('TAC-466')
    expect(header).toContain('cannot function as a second')
  })
})

describe('build-ready.yml pushes with the App token (TAC-463)', () => {
  // Until TAC-463 every build push went out as github-actions[bot]: the
  // checkout's persisted header outranked the App token in the remote URL,
  // and the job's token can never push a file under .github/workflows.
  const CHECKOUT = between(WORKFLOW, '      - uses: actions/checkout@v6', '      - uses: actions/setup-node')
  const WORK = between(WORKFLOW, '      - name: Work\n', '      - name: Check the session posted')

  it('keeps no credential in git config after the checkout', () => {
    expect(CHECKOUT).toContain('\n          persist-credentials: false\n')
    // The only checkout in the workflow: a second one would persist again.
    expect(WORKFLOW.match(/uses: actions\/checkout@/g)).toHaveLength(1)
  })

  it('asks the exchange for workflows: write', () => {
    expect(WORK).toContain('\n          additional_permissions: |\n            workflows: write\n')
  })

  it('never hands the session the job token', () => {
    // github_token replaces the App token with the one given, and the job's
    // token cannot push a workflow file whatever its permissions say.
    expect(WORK).not.toMatch(/^\s*github_token:/m)
  })
})

describe('build-ready.yml sets its turn limit in one place', () => {
  it('defaults to 120 when a run has no inputs', () => {
    expect(WORKFLOW).toContain('    env:\n      MAX_TURNS: ${{ inputs.max_turns || 120 }}\n')
  })

  it('passes that limit to the session', () => {
    expect(WORKFLOW).toContain('--max-turns ${{ env.MAX_TURNS }}\n')
    expect(WORKFLOW).not.toMatch(/--max-turns \d/)
  })

  it('lets only a manual dispatch lower it', () => {
    expect(INPUTS).toContain('      max_turns:\n')
    expect(between(INPUTS, '      max_turns:', 'type: number')).toContain('default: 120')
    expect(between(WORKFLOW, '  repository_dispatch:', '  workflow_dispatch:')).not.toContain('inputs')
  })

  it('tells the session its limit and to push as it goes', () => {
    expect(PROMPT).toContain('YOU HAVE ${{ env.MAX_TURNS }} TURNS.')
    expect(PROMPT).toContain('Never save pushes for the end.')
  })
})

describe('the check after the session reports the turn limit', () => {
  const run = CHECK

  it('is valid bash', () => {
    const r = spawnSync('bash', ['-n'], { input: run, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('asks the report script how the session ended, against the same limit', () => {
    expect(run).toContain('node "$REPORTER" ending "$EXECUTION_FILE" "$MAX_TURNS"')
    expect(run).toContain('node "$REPORTER" notice "$1" "$EXECUTION_FILE" "$MAX_TURNS"')
  })

  it('runs the copy taken before the session, never the checkout the session changed', () => {
    expect(run).not.toMatch(/node\s+(\.\/)?scripts\//)
    expect(WORKFLOW).toContain('REPORTER: ${{ runner.temp }}/turn-limit-reporter/run-report.mjs')
    expect(WORKFLOW).toContain('REPORTER_DIR: ${{ runner.temp }}/turn-limit-reporter\n')
    expect(WORKFLOW.indexOf('- name: Keep a copy of the turn-limit reporter')).toBeLessThan(WORKFLOW.indexOf('- name: Work'))
  })

  it('branches on the endings the script prints', () => {
    const compared = sorted([...run.matchAll(/"\$ENDING" = "([a-z-]+)"/g)].map((m) => m[1]))
    expect(compared).toEqual(sorted([ENDING.STOPPED_AT_LIMIT, ENDING.FINISHED_OVER_LIMIT]))
  })

  it('falls back to the old behaviour when the script fails', () => {
    expect(run).toContain('|| ENDING="unknown"')
    expect(run.match(/BODY=\$\(notice "\$TICKET"\) \|\| BODY=""/g)).toHaveLength(2)
  })

  it('never counts its own notices as the session\'s comment', () => {
    expect(alternation(run, /\\\\\[\(\?:([A-Z|-]+)\)\\\\\]"\) \| not\)\]/)).toEqual(WORKFLOW_NOTICES)
  })

  it('blocks the ticket and fails the run when the session was stopped', () => {
    const branch = run.slice(run.indexOf('if [ "$ENDING" = "stopped-at-limit" ]'), run.indexOf('if [ "$POSTED" -gt 0 ]'))
    expect(branch).toContain('LIMITED="$LIMITED $TICKET"')
    expect(branch).toContain('block "$ID" "$ISSUE"')
    expect(run).toContain('if [ -n "$SILENT" ] || [ -n "$LIMITED" ]; then\n  exit 1')
  })

  it('posts [OVER-LIMIT] only on a ticket the session did post on', () => {
    const posted = run.slice(run.indexOf('if [ "$POSTED" -gt 0 ]'))
    expect(posted.indexOf('"$ENDING" = "finished-over-limit"')).toBeGreaterThan(-1)
    expect(posted.indexOf('"$ENDING" = "finished-over-limit"')).toBeLessThan(posted.indexOf('continue'))
  })

  it('lets a failed [OVER-LIMIT] post warn without stopping [DENIALS]', () => {
    const over = between(run, 'if [ "$ENDING" = "finished-over-limit" ]', 'post_denials "$ID" "$TICKET"')
    expect(over).toContain('if post "$ID" "$BODY"; then')
    expect(over).not.toMatch(/^\s*post "\$ID" "\$BODY"$/m)
  })
})

describe('the copy of the reporter', () => {
  // Every module the entry imports, following relative imports.
  function imports(entry: string): string[] {
    const seen = new Set<string>()
    const visit = (path: string) => {
      if (seen.has(path)) return
      seen.add(path)
      for (const m of read(path).matchAll(/from '(\.[^']+)'/g)) visit(relative(ROOT, resolve(ROOT, dirname(path), m[1])))
    }
    visit(entry)
    return [...seen].sort()
  }

  it('copies exactly the modules the reporter imports', () => {
    const copied = [...SNAPSHOT.matchAll(/scripts\/[\w/-]+\.mjs/g)].map((m) => m[0])
    expect(sorted(copied)).toEqual(imports('scripts/run-report.mjs'))
  })

  it('runs on its own, outside the checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reporter-copy-'))
    try {
      const r = spawnSync('bash', ['-c', SNAPSHOT], { cwd: ROOT, env: { ...process.env, REPORTER_DIR: dir }, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      const out = execFileSync('node', [join(dir, 'run-report.mjs'), 'ending', join(dir, 'no-such-file.json'), '120'], {
        cwd: tmpdir(),
        encoding: 'utf8',
      })
      expect(out).toBe('no-record\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bookkeeping markers agree across the workflow', () => {
  it('the queue skips exactly the bookkeeping markers when finding the newest comment', () => {
    expect(alternation(QUEUE, /marker_is\("([A-Z|-]+)"\) \| not/)).toEqual(BOOKKEEPING)
  })

  it('the header says the same', () => {
    const line = WORKFLOW.slice(WORKFLOW.indexOf('# "Newest comment" skips'), WORKFLOW.indexOf('buries a ruling.'))
    expect(markersIn(line)).toEqual(BOOKKEEPING)
  })

  it('the resume instructions say the same', () => {
    const para = between(PROMPT, 'RESUMING.', 'bookkeeping, is human')
    expect(markersIn(para)).toEqual(BOOKKEEPING)
  })
})

describe('work-ticket.md', () => {
  const doc = read('.claude/commands/work-ticket.md')
  const line = (start: string) => {
    const found = doc.split('\n').find((l) => l.trimStart().startsWith(start))
    if (!found) throw new Error(`no line starting "${start}"`)
    return found
  }

  it('skips the same bookkeeping markers as the workflow, in both places it lists them', () => {
    expect(markersIn(line('- `bookkeeping` —'))).toEqual(BOOKKEEPING)
    const rule = line('- **Never exit silently on a ticket carrying')
    expect(markersIn(rule.slice(0, rule.indexOf('bookkeeping, is human input')))).toEqual(BOOKKEEPING)
  })

  it('knows both turn-limit markers', () => {
    const known = markersIn(line('2. **Compute.**'))
    expect(known).toContain('TURN-LIMIT')
    expect(known).toContain('OVER-LIMIT')
  })

  it('finds a branch an earlier run pushed', () => {
    const exists = line('- `branchExists` —')
    expect(exists).toContain("`git branch --list -a -i '*jaipal/tac-xxx-*'`")
    // The old glob was case-sensitive and local-only, so it missed the
    // lowercase branches CI sessions create and every branch on GitHub.
    expect(doc).not.toContain('jaipal/TAC-XXX')
  })

  it('continues that branch instead of starting over', () => {
    expect(line('14.')).toMatch(/^14\. \*\*Continue the ticket's branch if it exists\*\*/)
  })

  it('pushes each planned commit as it is made, never to main', () => {
    const step = line('15.')
    expect(step).toContain('**Push each commit as soon as it is made**')
    expect(step).toContain('Never to `main`, never `--force`.')
    expect(step).toContain('Do not open the PR here')
    expect(line('8.')).toContain('the commits the build will make in order')
  })
})

describe('.claude/process.md', () => {
  const doc = read('.claude/process.md')
  const rows = doc.split('\n').filter((l) => /^\| `\[[A-Z-]+\]` \|/.test(l))

  it('marks exactly the bookkeeping markers as bookkeeping in its marker table', () => {
    const bookkeeping = rows.filter((r) => r.split(' | ')[2]?.startsWith('Bookkeeping, not a turn'))
    expect(sorted(bookkeeping.map((r) => r.match(/^\| `\[([A-Z-]+)\]`/)![1]))).toEqual(BOOKKEEPING)
  })

  it('lists the same markers where it says bookkeeping is never the newest comment', () => {
    expect(markersIn(between(doc, '**Bookkeeping comments (', ') never count as the newest comment.**'))).toEqual(BOOKKEEPING)
  })

  it('describes [TURN-LIMIT] as blocking', () => {
    const row = rows.find((r) => r.startsWith('| `[TURN-LIMIT]` |'))
    expect(row).toContain('**not bookkeeping**')
    expect(row).toContain('Adds `Needs Decision`')
  })

  it('says how to test a workflow change and what "Do not self-commit" means', () => {
    expect(doc).toContain('## Testing a workflow change')
    expect(doc).toContain('**The fixture-ticket pattern:**')
    expect(doc).toContain('It means **no\ncommit to `main`, and no merge**.')
  })
})

describe('the Slack sync', () => {
  const slack = read('scripts/slack-rulings.mjs')
  const set = slack.match(/const BLOCKING_MARKERS = new Set\(\[([\s\S]*?)\]\)/)
  if (!set) throw new Error('BLOCKING_MARKERS moved')
  const blocking = [...set[1].matchAll(/'([A-Z-]+)'/g)].map((m) => m[1])

  it('forwards [TURN-LIMIT], which needs Jaipal, and not [OVER-LIMIT], which is bookkeeping', () => {
    expect(blocking).toContain('TURN-LIMIT')
    expect(blocking).not.toContain('OVER-LIMIT')
  })

  it('tells him what a reply to [TURN-LIMIT] does', () => {
    expect(slack).toContain("if (marker === 'TURN-LIMIT') {")
  })

  it('lists the same bookkeeping markers in its header', () => {
    const line = slack.slice(slack.indexOf('build-ready.yml and work-ticket.md both skip'), slack.indexOf('when deciding who spoke last'))
    expect(markersIn(line)).toEqual(BOOKKEEPING)
  })
})
