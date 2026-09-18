import yaml from 'js-yaml'

// How Claude Code matches a --allowedTools / --disallowedTools Bash rule
// against a command, for the tests that read the workflow files. Test-only:
// nothing in a workflow imports it. It models the documented rule, not
// Claude Code's code, so it proves what an allowlist says, not what Claude
// Code does; only a real run shows that. Moved here from
// linear-prompts.test.ts (TAC-449) so bash-allowlist.test.ts can share it
// (TAC-471).

// Bash(x) allows exactly x; Bash(x:*) allows x, or x followed by a space and
// anything. The space is part of the rule: Bash(git checkout jaipal/:*)
// admits `git checkout jaipal/ foo` and never `git checkout jaipal/foo`, which
// run 35323004309 showed Claude Code doing too (TAC-471). Any other `*` is a
// form this doesn't model, and treating it as an exact match would let a deny
// rule such as Bash(node *) pass unseen, so it throws.
export function allows(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule)
  if (!m) return false
  if (m[1].replace(/:\*$/, '').includes('*')) throw new Error(`unmodelled wildcard rule: ${rule}`)
  if (!m[1].endsWith(':*')) return command === m[1]
  const prefix = m[1].slice(0, -2)
  return command === prefix || command.startsWith(`${prefix} `)
}

// A command a session can run: an allow rule admits it and no deny rule
// does. A deny rule wins over an allow rule.
export function permits(allowed: readonly string[], disallowed: readonly string[], command: string): boolean {
  return allowed.some((rule) => allows(rule, command)) && !disallowed.some((rule) => allows(rule, command))
}

type Step = { uses?: string; with?: { claude_args?: string; prompt?: string } }

// The claude-code-action step of a workflow: its claude_args and its prompt.
export function claudeStep(src: string): { args: string; prompt: string } {
  const doc = yaml.load(src) as { jobs: Record<string, { steps: Step[] }> }
  const step = Object.values(doc.jobs)
    .flatMap((job) => job.steps)
    .find((s) => s.uses?.startsWith('anthropics/claude-code-action'))
  if (!step?.with?.claude_args || !step.with.prompt) throw new Error('no claude-code-action step')
  return { args: step.with.claude_args, prompt: step.with.prompt }
}

// The rules one flag of claude_args lists.
export function toolList(args: string, flag: '--allowedTools' | '--disallowedTools'): string[] {
  const m = new RegExp(`${flag} "([^"]*)"`).exec(args)
  if (!m) throw new Error(`no ${flag}`)
  return m[1].split(',')
}
