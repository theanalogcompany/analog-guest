import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allows, claudeStep, permits, toolList } from './bash-allowlist'

// TAC-471. The build allowlist against the commands sessions run and the
// commands the prompts teach. Nothing runs a workflow under test, so this
// reads the files, and `allows` models Claude Code's documented rule: these
// tests prove what the allowlist says, not what Claude Code does. The lists
// below are written out by hand, never derived from the allowlist, because a
// list read out of the allowlist can only agree with it.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

const { args, prompt } = claudeStep(read('.github/workflows/build-ready.yml'))
const allowed = toolList(args, '--allowedTools')
const disallowed = toolList(args, '--disallowedTools')
const can = (command: string) => permits(allowed, disallowed, command)

// The text between two markers that must each appear exactly once.
function between(text: string, start: string, end: string) {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0 || text.indexOf(start, from + 1) >= 0) throw new Error(`"${start}" … "${end}" moved`)
  return text.slice(from, to)
}

// Every command a stretch of prose names, from its inline code spans and
// fenced blocks, with placeholders filled in. A placeholder not listed here
// throws, so a new one is noticed rather than tested as literal text.
const PLACEHOLDERS: Record<string, string> = {
  '<branch>': 'jaipal/tac-325-order-capture',
  '<file>': 'scratch.txt',
  '<filename>': 'scripts/lib/claims.test.ts',
  '<path>': 'lib/utils.ts',
  '<ref>': 'jaipal/tac-325-order-capture',
  '<x>': 'x',
}
function commandsIn(text: string) {
  const fenced = [...text.matchAll(/```\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n'))
  const spans = [...text.replace(/```\n[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  return [...fenced, ...spans]
    .map((s) => s.trim())
    .filter((s) => /^(git|npx|npm|gh|node|rm|cd) /.test(s))
    .map((s) =>
      s.replace(/<[^>]+>/g, (p) => {
        if (!(p in PLACEHOLDERS)) throw new Error(`unknown placeholder ${p} in: ${s}`)
        return PLACEHOLDERS[p]
      }),
    )
}

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
    'git push -u origin jaipal/tac-471-allowlist-and-resume',
    'git push',
    "gh api repos/theanalogcompany/analog-guest/activity --jq '.[] | .actor.login'",
  ]

  // What discards work, rewrites history, or was never needed.
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
    'git reset --hard origin/main',
    'git clean -fd',
    'git branch -D jaipal/tac-325-order-capture',
    'git stash',
    'git stash push -u -- lib',
    'git restore lib/utils.ts',
    'rm -f .git-commit-msg-tac443.txt',
    'gh api repos/theanalogcompany/analog-guest/pulls',
    'gh api -X DELETE repos/theanalogcompany/analog-guest/git/refs/heads/jaipal/tac-325-order-capture',
    'npm install',
  ]

  // KNOWN GAPS. A deny rule catches a flag only where it names it, so these
  // pass, and each discards work or rewrites a branch. Closing one fails
  // this test: move it to REFUSED and update the list in CLAUDE.md ("A
  // Bash(x:*) rule matches x followed by a space").
  const KNOWN_GAPS = [
    'git push origin jaipal/tac-325-order-capture --force',
    'git push origin +jaipal/tac-325-order-capture:jaipal/tac-325-order-capture',
    'git push --force-with-lease=jaipal/tac-325-order-capture',
    'git push origin --delete jaipal/tac-325-order-capture',
    'git switch jaipal/tac-325-order-capture --discard-changes',
    'git worktree remove .worktrees/x --force',
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

// A command the prompts teach is never one the allowlist refuses.
describe('what the prompts teach, the allowlist permits', () => {
  // `cd` has no rule: Claude Code admits a single cd into the checkout on its
  // own, and refuses a second in one command (run 35323004309).
  const nativelyAdmitted = (command: string) => /^cd \S+$/.test(command) && !command.includes('..')
  // Commands the prose names only to say they are refused.
  const NAMED_AS_REFUSED = ['git stash', 'npm install']

  const checkTaught = (text: string) => {
    const commands = commandsIn(text)
    for (const command of commands) {
      if (nativelyAdmitted(command)) continue
      if (NAMED_AS_REFUSED.includes(command)) {
        expect({ command, permitted: can(command) }).toEqual({ command, permitted: false })
        continue
      }
      expect({ command, permitted: can(command) }).toEqual({ command, permitted: true })
    }
    return commands
  }

  it('work-ticket.md step 14', () => {
    const step = between(read('.claude/commands/work-ticket.md'), '14. **Continue the ticket', '\n15. ')
    const commands = checkTaught(step)
    // Zero would pass every assertion and prove nothing.
    expect(commands).toContain('git worktree add .worktrees/jaipal/tac-325-order-capture jaipal/tac-325-order-capture')
    expect(commands).toContain('git log --oneline origin/main..origin/jaipal/tac-325-order-capture')
    expect(commands).toContain('git checkout -b jaipal/tac-xxx-short-description')
  })

  it('CLAUDE.md\'s test baseline', () => {
    const baseline = between(read('CLAUDE.md'), 'To get a trustworthy before/after on a branch', 'THE-164 covers')
    const commands = checkTaught(baseline)
    expect(commands.slice(0, 3)).toEqual([
      'git worktree add .worktrees/baseline origin/main',
      'npx vitest run --root .worktrees/baseline',
      'git worktree remove .worktrees/baseline',
    ])
  })

  it('CLAUDE.md\'s push-actor check', () => {
    const entry = between(read('CLAUDE.md'), "- **A build session's `git push` used the job's own token", '\n- ')
    const commands = checkTaught(entry).filter((command) => command.startsWith('gh api'))
    expect(commands).toHaveLength(1)
  })

  it('the build prompt no longer teaches checking the branch out to resume', () => {
    const resuming = between(prompt, 'RESUMING.', 'ALWAYS POST BEFORE YOU EXIT.')
    expect(resuming).toContain('do not check it out')
    expect(resuming).not.toMatch(/check it out \(/)
  })
})

// The list CLAUDE.md gives of what stays refused, and of what passes the
// deny list, agree with the allowlist.
describe('CLAUDE.md\'s account of the allowlist', () => {
  const entry = between(read('CLAUDE.md'), '- **A `Bash(x:*)` rule matches `x` followed by a space', '\n- ')

  it('names only refused commands as refused', () => {
    const commands = commandsIn(between(entry, 'What stays refused on purpose', 'Three facts about a worktree'))
    expect(commands).toContain('git stash')
    for (const command of commands) {
      expect({ command, permitted: can(command) }).toEqual({ command, permitted: false })
    }
  })

  it('names only commands that pass as passing', () => {
    const commands = commandsIn(between(entry, 'as the first argument, but', 'all pass.'))
    expect(commands.length).toBeGreaterThanOrEqual(6)
    for (const command of commands) {
      expect({ command, permitted: can(command) }).toEqual({ command, permitted: true })
    }
  })
})
