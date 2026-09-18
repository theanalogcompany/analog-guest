import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allows, claudeStep, permits, permitsCommandLine, toolList } from './bash-allowlist'

// TAC-471. The build allowlist against the commands sessions run and the
// commands the prompts teach. Nothing runs a workflow under test, so this
// reads the files, and the model follows Claude Code's documented rule: these
// tests prove what the allowlist says, not what Claude Code does. The lists
// below are written out by hand, never derived from the allowlist, because a
// list read out of the allowlist can only agree with it.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

// Where a CI session's checkout is, for a cd by absolute path.
const CHECKOUT = '/home/runner/work/analog-guest/analog-guest'

const { args, prompt } = claudeStep(read('.github/workflows/build-ready.yml'))
const allowed = toolList(args, '--allowedTools')
const disallowed = toolList(args, '--disallowedTools')
const can = (command: string) => permits(allowed, disallowed, command)
const canRun = (line: string) => permitsCommandLine(allowed, disallowed, line, CHECKOUT)

// The text between two markers that must each appear exactly once.
function between(text: string, start: string, end: string) {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0 || text.indexOf(start, from + 1) >= 0) throw new Error(`"${start}" … "${end}" moved`)
  return text.slice(from, to)
}

// Every command a stretch of prose names: each inline code span, and each
// line of a fenced block (with or without a language tag), that opens with a
// lowercase program name and an argument. Placeholders are filled in; one not
// listed here throws, so a new one is noticed rather than tested as literal
// text. What this cannot see is a command written in plain prose.
const PLACEHOLDERS: Record<string, string> = {
  '<branch>': 'jaipal/tac-325-order-capture',
  '<file>': 'scratch.txt',
  '<filename>': 'scripts/lib/claims.test.ts',
  '<id>': '35323004309',
  '<number>': '221',
  '<path>': 'lib/utils.ts',
  '<ref>': 'jaipal/tac-325-order-capture',
  '<x>': 'x',
}
const FENCE = /```[a-z]*\n([\s\S]*?)```/g
function commandsIn(text: string) {
  const fenced = [...text.matchAll(FENCE)].flatMap((m) => m[1].split('\n'))
  const spans = [...text.replace(FENCE, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  return [...fenced, ...spans]
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-z0-9._-]* \S/.test(s))
    .map((s) =>
      s.replace(/<[a-z]+>/g, (p) => {
        if (!(p in PLACEHOLDERS)) throw new Error(`unknown placeholder ${p} in: ${s}`)
        return PLACEHOLDERS[p]
      }),
    )
}
const refusedIn = (commands: string[]) => commands.filter((command) => !canRun(command))

describe('allows', () => {
  it('admits exactly the command a rule without :* names', () => {
    expect(allows('Bash(git checkout main)', 'git checkout main')).toBe(true)
    expect(allows('Bash(git checkout main)', 'git checkout main -- lib')).toBe(false)
  })

  it('admits a :* rule\'s prefix alone, or followed by a space', () => {
    expect(allows('Bash(git switch:*)', 'git switch')).toBe(true)
    expect(allows('Bash(git switch:*)', 'git switch main')).toBe(true)
    expect(allows('Bash(git switch:*)', 'git switchx')).toBe(false)
  })

  // The finding TAC-471 rests on: run 35323004309 denied the first form and
  // admitted the second under this exact rule.
  it('never admits a branch name glued to a prefix that ends in a slash', () => {
    expect(allows('Bash(git checkout jaipal/:*)', 'git checkout jaipal/tac-325-order-capture')).toBe(false)
    expect(allows('Bash(git checkout jaipal/:*)', 'git checkout jaipal/ tac-325-order-capture')).toBe(true)
  })

  it('reads a tool that is not Bash as no match', () => {
    expect(allows('Read', 'Read')).toBe(false)
  })

  it('throws on a wildcard it does not model', () => {
    expect(() => allows('Bash(node *)', 'node x')).toThrow('unmodelled wildcard rule')
    expect(() => allows('Bash(git push * --force)', 'git push origin x --force')).toThrow('unmodelled wildcard rule')
  })
})

describe('permits', () => {
  it('lets a deny rule win over an allow rule', () => {
    expect(permits(['Bash(git push:*)'], ['Bash(git push --force:*)'], 'git push --force')).toBe(false)
    expect(permits(['Bash(git push:*)'], ['Bash(git push --force:*)'], 'git push')).toBe(true)
  })

  it('refuses what no allow rule names', () => {
    expect(permits([], [], 'git status')).toBe(false)
  })
})

describe('permitsCommandLine', () => {
  const ALLOW = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(jq:*)', 'Bash(gh api repos/o/r/activity:*)']
  const run = (line: string) => permitsCommandLine(ALLOW, ['Bash(git push --force:*)'], line, '/work/repo')

  it('checks every part of a compound command', () => {
    expect(run('git status && git diff')).toBe(true)
    expect(run('git status && git push --force')).toBe(false)
    expect(run('git status || git log')).toBe(false)
    expect(run('git status; git log')).toBe(false)
    expect(run('git diff | jq .')).toBe(true)
    expect(run('git diff | head -5')).toBe(false)
  })

  it('does not split on an operator inside single quotes', () => {
    expect(run("gh api repos/o/r/activity --jq '.[] | select(.ref == \"x\") | .actor.login'")).toBe(true)
  })

  it('refuses the shell forms CI denies however they are arranged', () => {
    expect(run('git diff > out.txt')).toBe(false)
    expect(run('git diff 2>&1')).toBe(false)
    expect(run('git diff $REF')).toBe(false)
    expect(run('git diff "$REF"')).toBe(false)
    expect(run('git diff $(cat ref)')).toBe(false)
    expect(run('jq . <<EOF')).toBe(false)
    expect(run("git diff 'unclosed")).toBe(false)
  })

  it('admits one cd inside the checkout, and no other', () => {
    expect(run('cd .worktrees/jaipal/tac-1-x')).toBe(true)
    expect(run('cd .worktrees/x && git status')).toBe(true)
    expect(run('cd /work/repo')).toBe(true)
    expect(run('cd /work/repo/.worktrees/x')).toBe(true)
    // Each cd alone is admitted, so only the one-cd rule refuses this.
    expect(run('cd .worktrees/x && git status && cd .worktrees/y')).toBe(false)
    expect(run('cd .worktrees/x && git status && cd ..')).toBe(false)
    expect(run('cd ..')).toBe(false)
    expect(run('cd /tmp/x')).toBe(false)
    expect(run('cd /work/repository')).toBe(false)
    expect(run('cd ~')).toBe(false)
  })
})

describe('the build allowlist', () => {
  // Commands sessions need, including each one refused in the TAC-325,
  // TAC-376 and TAC-443 runs that the ticket permits, and the forms step 14
  // and the test baseline teach.
  const PERMITTED = [
    'npx tsc --noEmit',
    'npx vitest run',
    'npx vitest run --root .worktrees/baseline',
    'npx vitest list --filesOnly scripts/lib/claims.test.ts',
    'npm run lint',
    'npx eslint scripts/lib/claims.mjs scripts/lib/claims.test.ts',
    'npm run build',
    'git checkout main',
    'git checkout -b jaipal/tac-471-allowlist-and-resume',
    'git switch main',
    'git switch jaipal/tac-325-order-capture',
    'git fetch origin jaipal/tac-325-order-capture',
    'git log --oneline origin/main..origin/jaipal/tac-325-order-capture',
    'git diff origin/main...origin/jaipal/tac-325-order-capture',
    'git worktree add .worktrees/baseline origin/main',
    'git worktree add .worktrees/jaipal/tac-325-order-capture jaipal/tac-325-order-capture',
    'git worktree list',
    'git worktree remove .worktrees/baseline',
    'git pull --ff-only',
    'git push -u origin jaipal/tac-471-allowlist-and-resume',
    'git push',
    'gh pr create --draft',
    "gh api repos/theanalogcompany/analog-guest/activity --jq '.[] | .actor.login'",
  ]

  // What discards work, rewrites or deletes a branch, breaks a hard rule, or
  // was never needed.
  const REFUSED = [
    // The taught resume form. No rule admits it without also admitting a
    // path after it, which discards work, so it stays refused on purpose.
    'git checkout jaipal/tac-325-order-capture',
    'git checkout .',
    'git checkout -- lib/utils.ts',
    'git checkout -- .',
    'git switch --discard-changes main',
    'git switch -f main',
    'git switch --force main',
    'git switch -C jaipal/tac-325-order-capture',
    'git switch --force-create jaipal/tac-325-order-capture',
    'git worktree add -B jaipal/tac-325-order-capture .worktrees/x origin/jaipal/tac-325-order-capture',
    'git worktree remove -f .worktrees/x',
    'git worktree remove --force .worktrees/x',
    'git push --force',
    'git push -f origin jaipal/tac-325-order-capture',
    'git push --force-with-lease',
    'git push --mirror',
    'git push --prune origin refs/heads/*:refs/heads/*',
    'git push -d origin jaipal/tac-325-order-capture',
    'git push --delete origin jaipal/tac-325-order-capture',
    'git reset --hard origin/main',
    'git clean -fd',
    'git branch -D jaipal/tac-325-order-capture',
    'git stash',
    'git stash push -u -- lib',
    'git restore lib/utils.ts',
    'git rebase main',
    'rm -f .git-commit-msg-tac443.txt',
    'gh pr merge 221 --squash',
    'gh pr checkout 221',
    'gh api repos/theanalogcompany/analog-guest/pulls',
    'gh api -X DELETE repos/theanalogcompany/analog-guest/git/refs/heads/jaipal/tac-325-order-capture',
    'npm install',
  ]

  // KNOWN GAPS. A deny rule catches a flag only where it names it, so these
  // pass, and each discards work, or resets, rewrites or deletes a branch.
  // CLAUDE.md lists exactly these ("A Bash(x:*) rule matches x followed by a
  // space"), and a test below holds the two lists equal. Closing one fails
  // this test: move it to REFUSED and take it off that list.
  const KNOWN_GAPS = [
    'git push origin jaipal/tac-325-order-capture --force',
    'git push -fu origin jaipal/tac-325-order-capture',
    'git push origin +jaipal/tac-325-order-capture:jaipal/tac-325-order-capture',
    'git push --force-with-lease=jaipal/tac-325-order-capture',
    'git push origin --mirror',
    'git push origin --delete jaipal/tac-325-order-capture',
    'git push origin :jaipal/tac-325-order-capture',
    'git switch jaipal/tac-325-order-capture -f',
    'git switch jaipal/tac-325-order-capture --discard-changes',
    'git switch -fc jaipal/tac-325-order-capture origin/main',
    'git checkout -b jaipal/tac-325-order-capture -f',
    'git worktree add .worktrees/x -B jaipal/tac-325-order-capture origin/jaipal/tac-325-order-capture',
    'git worktree remove .worktrees/x --force',
    'git worktree remove -ff .worktrees/x',
    'git fetch origin +main:jaipal/tac-325-order-capture',
  ]

  it.each(PERMITTED)('permits %s', (command) => {
    expect(can(command)).toBe(true)
  })

  it.each(REFUSED)('refuses %s', (command) => {
    expect(can(command)).toBe(false)
  })

  it.each(KNOWN_GAPS)('KNOWN GAP: still permits %s', (command) => {
    expect(can(command)).toBe(true)
  })

  it('lists the same known gaps as CLAUDE.md', () => {
    const entry = between(read('CLAUDE.md'), '- **A `Bash(x:*)` rule matches `x` followed by a space', '\n- ')
    expect(commandsIn(between(entry, 'These all pass:', 'Each discards')).sort()).toEqual([...KNOWN_GAPS].sort())
  })

  // No allow rule admits these today, so the deny rules for them are
  // redundant until someone permits more of checkout. That is when they
  // matter, so test them against a checkout rule as wide as it can get.
  it.each(['git checkout .', 'git checkout -- lib/utils.ts', 'git checkout -- .'])(
    'still refuses %s if a later edit permits every checkout',
    (command) => {
      expect(permits([...allowed, 'Bash(git checkout:*)'], disallowed, command)).toBe(false)
    },
  )

  it('no longer carries the checkout rule that never matched a branch name', () => {
    expect(allowed).not.toContain('Bash(git checkout jaipal/:*)')
    expect(allowed.filter((rule) => rule.startsWith('Bash(git checkout'))).toEqual(['Bash(git checkout main)', 'Bash(git checkout -b:*)'])
  })

  it('reads the activity endpoint and nothing else through gh api', () => {
    expect(allowed.filter((rule) => rule.startsWith('Bash(gh api'))).toEqual(['Bash(gh api repos/theanalogcompany/analog-guest/activity:*)'])
  })
})

// A command the prompts teach is never one the allowlist refuses. Each text
// may name a refused command only to say it is refused, and those are pinned
// here one by one, so a second mention, or a refused command taught, fails.
// process.md is not scanned: its fenced blocks are example comments, and its
// one command (dispatching a workflow against a fixture) is Jaipal's.
describe('what the prompts teach, the allowlist permits', () => {
  it('all of work-ticket.md', () => {
    const commands = commandsIn(read('.claude/commands/work-ticket.md'))
    // Step 14 says npm install is refused; Phase 5 says Jaipal runs the merge.
    expect(refusedIn(commands)).toEqual(['npm install', 'gh pr merge --squash --delete-branch'])
    // Zero would pass every assertion and prove nothing.
    expect(commands).toContain('git worktree add .worktrees/jaipal/tac-325-order-capture jaipal/tac-325-order-capture')
    expect(commands).toContain('git log --oneline origin/main..origin/jaipal/tac-325-order-capture')
    expect(commands).toContain('cd .worktrees/jaipal/tac-325-order-capture')
  })

  it('the build prompt\'s command lines', () => {
    // The prompt teaches commands as indented lines, not code spans. GitHub
    // expands ${{ runner.temp }} before the session sees it.
    const lines = prompt
      .split('\n')
      .map((line) => line.trim().replaceAll('${{ runner.temp }}', '/home/runner/work/_temp'))
      .filter((line) => /^(curl|node|git|npx|npm|gh|jq|rg) /.test(line))
    expect(lines.length).toBeGreaterThanOrEqual(6)
    expect(refusedIn(lines)).toEqual([])
    expect(refusedIn(commandsIn(prompt))).toEqual([])
  })

  it('the build prompt no longer teaches checking the branch out to resume', () => {
    const resuming = between(prompt, 'RESUMING.', 'ALWAYS POST BEFORE YOU EXIT.')
    expect(resuming).toContain('do not check it out')
    expect(resuming).not.toMatch(/check it out \(/)
  })

  it('CLAUDE.md\'s test baseline', () => {
    const commands = commandsIn(between(read('CLAUDE.md'), 'To get a trustworthy before/after on a branch', 'THE-164 covers'))
    expect(commands.slice(0, 3)).toEqual([
      'git worktree add .worktrees/baseline origin/main',
      'npx vitest run --root .worktrees/baseline',
      'git worktree remove .worktrees/baseline',
    ])
    // Named once, to say it is what the baseline used to use.
    expect(refusedIn(commands)).toEqual(['git stash'])
  })

  it('CLAUDE.md\'s push-actor check', () => {
    const commands = commandsIn(between(read('CLAUDE.md'), "- **A build session's `git push` used the job's own token", '\n- '))
    expect(commands.filter((command) => command.startsWith('gh api'))).toHaveLength(1)
    expect(refusedIn(commands)).toEqual([])
  })
})

describe('CLAUDE.md\'s list of what stays refused', () => {
  it('names only refused commands', () => {
    const entry = between(read('CLAUDE.md'), '- **A `Bash(x:*)` rule matches `x` followed by a space', '\n- ')
    const commands = commandsIn(between(entry, 'What stays refused on purpose', 'Five facts about a worktree'))
    expect(commands).toContain('git stash')
    expect(commands).toContain('gh pr merge 221')
    expect(refusedIn(commands)).toEqual(commands)
  })
})
