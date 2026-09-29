# .github - what a CI session may run

Loads when you work on a workflow. Root `CLAUDE.md` has the project-wide rules.

A CI Claude Code session runs under the `claude_args` allowlist in
`.github/workflows/build-ready.yml`. `scripts/lib/bash-allowlist.test.ts` models that
allowlist and **binds the lists below to it**: closing a gap, or permitting something this
file records as refused, fails that test until the list and the allowlist move together.

That test reads this file and locates each block by an exact phrase, and it throws if a
phrase occurs twice. So when editing: do not paraphrase a heading, and do not repeat one
in prose.

## How a Bash rule matches, and what that leaves open

- **A `Bash(x:*)` rule matches `x` followed by a space, never `x` with more text glued on, and deny
  rules work the same way (TAC-471).** `Bash(git checkout jaipal/:*)` (TAC-439) admitted
  `git checkout jaipal/`, a space and anything, so it refused `git checkout jaipal/tac-325-...`, the
  resume command `work-ticket.md` step 14 taught, on every resume. Proven in run 35323004309: the
  taught form was denied, and `git checkout jaipal/ tac-325-...`, which git itself rejects, was
  admitted. Two consequences:
  1. **No rule can admit `git checkout <branch>` without also admitting
`git checkout <branch> -- <path>`**, which discards uncommitted changes: whatever admits the name
admits what follows it. So CI permits `git switch` instead (it has no path form, and its discard and
reset flags are denied by name), and a resume never checks the branch out. It reads
`origin/<branch>` and continues in a side folder, always `<checkout>/.worktrees/resume`, by its
absolute path (step 14).
  2. **A deny rule catches a flag only in the position and spelling it names.** The build deny list
refuses `git push` with `--force`, `-f`, `--force-with-lease`, `--mirror`, `--prune`, `-d` or
`--delete` as its first argument, and `git switch` with `-f`, `--force`, `--discard-changes`, `-C`
or `--force-create`. These all pass: `git push origin <branch> --force`,
`git push -fu origin <branch>`, `git push origin +<branch>:<branch>`,
`git push --force-with-lease=<ref>`, `git push origin --mirror`, `git push origin --delete <branch>`
, `git push origin :<branch>`, `git switch <branch> -f`, `git switch <branch> --discard-changes`,
`git switch -fc <branch> origin/main`, `git checkout -b <branch> -f`,
`git worktree add .worktrees/<x> -B <branch> origin/<branch>`,
`git worktree remove .worktrees/<x> --force`, `git worktree remove -ff .worktrees/<x>`,
`git fetch origin +main:<branch>`, `git pull --ff-only origin +main:<branch>`. Each discards
uncommitted work, or resets, rewrites or deletes a branch. Each push form and the pull form in that
list pass from the side folder too, with `-C` and the folder's path, and a test holds that as well.
Before TAC-471 no force push was denied at all, so this narrows the hole without closing it.
`scripts/lib/bash-allowlist.test.ts` pins exactly this list as known gaps and holds its own copy
equal to it, so closing a gap fails a test; a gap found later fails nothing until it is added to
both. Whether a rule with `*` anywhere else would close them is untested: the test's model covers
only `Bash(x)` and `Bash(x:*)`, and throws on any other `*`.

  What stays refused on purpose, with the alternative the prompts teach: `git stash` (the test
baseline runs in a worktree, see "Testing"); `git checkout <branch>` and `gh pr checkout <number>`
(step 14's side folder); `git checkout -- <path>` and `git checkout .` (none: they discard work);
`git reset`, `git clean` and `git branch -D` (none); `gh pr merge <number>` and
`gh pr ready <number>` (Jaipal merges, and marks a PR ready; the allowlist grants `gh pr` only as
create, list, view, diff and checks, because `gh pr -R <repo> merge <number>` walks past a deny rule
for `gh pr merge`); `rm <file>` (leave scratch files where they are, named `.txt` or `.md`, and
stage files by name; nothing uncommitted outlives the runner). Facts about a side folder under
`.worktrees/`, each checked live on this repo, except where marked. "Live" means Claude Code 2.1.273
run headless locally under this allowlist, not CI, which runs 2.1.275 or later through
claude-code-action, so the first fixture resume run after merge is the first real proof:
`npx tsc --noEmit -p`, `npx eslint` and `npx vitest run --root`, given the folder's absolute path,
resolve this checkout's `node_modules`, so nothing is installed; ESLint 9 reads its config from the
directory it runs in, so from this checkout it lints the folder with `main`'s config, and
`--flag v10_config_lookup_from_file` makes it use the folder's own (checked with a rule only the
folder's config had); the pre-commit hook does not run in it, because husky makes its hook directory
on `npm install`; while it exists, `npx vitest run` and `npm run lint` in this checkout collect its
copy, where `npx tsc` does not (TypeScript's `**` skips dot-directories, which is why
`tsconfig.json` names `.next/types` explicitly); **Claude Code refuses `cd` and `git` in one
command** ("cd before a git command needs approval"), with a relative path or an absolute one,
whatever the allowlist says, so git there runs with `-C` and the folder's absolute path, which the
allowlist names exactly: it grants `status`, `log`, `diff`, `show`, `add`, `commit`, `push` and
`pull --ff-only` there, and mirrors the push deny rules; the path is fixed,
`<checkout>/.worktrees/resume`, because a branch-named folder would put the branch name after the
rule's prefix, which is the space trap above; a lone `cd` is admitted and does persist, but nothing
relies on it (ruled 2026-09-18); Read, Edit and Write take absolute paths, so step 14 gives them the
folder's; a subagent starts in this checkout (reported by one, not checked), so its handoff names
the folder's absolute path; and whether Grep and Glob default to the shell's directory is untested,
so step 14 gives them the path too; and the `[TURN-LIMIT]` notice reads each side folder with
`git -C <path> status --porcelain` (`scripts/lib/run-report.mjs`), because this checkout's own
status cannot see inside a gitignored folder. It lists that work; it cannot save it.

## Measuring the test baseline

To get a trustworthy before/after on a branch, run the "before" in a throwaway worktree, which
leaves this checkout and its changes alone (TAC-471; this used to be `git stash`, which CI refuses,
and a stash a session never pops is lost work):

```
git worktree add .worktrees/baseline origin/main
npx vitest run --root .worktrees/baseline
git worktree remove .worktrees/baseline
```

**The worktree has to live inside the checkout, which is what `.worktrees/` above is for**: created
  anywhere else (a session scratchpad under `/private/tmp`, say) Node cannot walk up to this repo's
  `node_modules`, and the run dies at `Cannot find module 'vitest/config'` while loading the config,
  which reads as a broken branch rather than a misplaced worktree. Use `HEAD` in place of
  `origin/main` while your change is still uncommitted, and the parent of your branch's first commit
  (the oldest one `git log --oneline origin/main..HEAD` lists, with `^` after it) if `main` has
  moved since you branched. `--root` runs the worktree's own tests under its own `vitest.config.ts`
  (checked: a config change made only in the worktree changes what runs) and resolves this
  checkout's `node_modules`, so nothing is installed and nothing needs a `cd`. Remove the worktree
  straight after: while it is under `.worktrees/`, `npx vitest run` here collects its test files as
  well. Then run `npx vitest run` here for the "after", adding `--exclude '.claude/**'` in a local
  checkout that has worktrees there (the TAC-395 gotcha), so both runs collect the same files. On a
  resume, the "after" is `npx vitest run --root <checkout>/.worktrees/resume`: run here, it would
  test the side folder's copy against `main`'s code. `npx vitest list --filesOnly <filename>` proves
  a specific file is actually collected rather than silently skipped: it prints the path, or
  nothing.

THE-164 covers expanding test coverage.

## Which token pushed

- **A build session's `git push` used the job's own token, not the Claude App token, until
  TAC-463.** `actions/checkout@v6` keeps the job's `GITHUB_TOKEN` as an
  `http.https://github.com/.extraheader` in a file the repo config includes with
  `includeIf.gitdir:<gitdir>.path`. claude-code-action's scrub (`replaceCheckoutCredentials`,
  unchanged at `v1` as of 2026-09-18) checks only the local config and `include.path`, logs
  `No existing authentication headers to remove`, and puts the App token in the remote URL. git
  sends the extra header on every request, so the URL token was never used. Every build push until
  then was recorded as `github-actions[bot]` while the same sessions' PRs opened as `app/claude`,
  and run 35299836324 was refused a push under `.github/workflows/`: the job token can never carry
  `workflows`, and GitHub offers no `workflows` key for a `permissions:` block. `build-ready.yml`
  now checks out with `persist-credentials: false` and asks the exchange for `workflows: write`
  through `additional_permissions`. **To see which token pushed, read the `actor` in
  `GET /repos/{owner}/{repo}/activity`**, which a build session can do only in exactly this form,
  the one use of gh's API command its allowlist admits (TAC-471):
  `gh api repos/theanalogcompany/analog-guest/activity --jq '.[] | select(.ref == "refs/heads/<branch>") | .actor.login'`
  . **The commit author proves nothing**: the build commits as
  `41898282+claude[bot]@users.noreply.github.com`, 41898282 is github-actions' own user id, so
  GitHub links those commits to github-actions[bot] whichever token pushed them. analog-operator's
  `build-ready.yml` has the same setup.

- **`analog-operator`'s `build-ready.yml` has the same setup**, so a token or allowlist
  finding here applies there too. The two allowlists are kept in step by
  `scripts/lib/linear-prompts.test.ts`.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
