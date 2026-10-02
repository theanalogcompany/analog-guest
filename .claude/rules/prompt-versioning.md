---
paths:
  - "lib/ai/prompts/**"
  - "lib/ai/generate-message.ts"
  - "lib/ai/classify-message.ts"
  - "lib/agent/**"
  - "lib/voices/**"
---

# Bumping PROMPT_VERSION is a repo-wide sweep

`PROMPT_VERSION` lives in `lib/ai/prompts/system-template.ts`. Changing the composed prompt
means bumping it, and the bump touches files in several directories. This file loads only when
you read the directories that own the composed prompt; the sweep itself is repo-wide.

## Grep. Never read a list, including this one.

```
grep -rn "v1\.<old>\.<new>" --include='*.ts' --include='*.md' .
```

**`--include='*.md'` is not optional.** Two sites live in prose rather than code - the
constants table in the root `CLAUDE.md` and the `PROMPT_VERSION` sentence in `lib/ai/CLAUDE.md`
- so a `*.ts`-only sweep cannot see either.

**A carried count is worse than no count - no count makes you grep, a stale one tells you
that you already did.** **Re-run the grep after EVERY rebase**, and do not carry the earlier
result forward: commits the rebase picks up can add new sites, and nothing else will flag them.

## Two kinds of hit you must NOT change

1. **`system-template.ts`'s own changelog entry** for the old version. That is history.
2. **Comments elsewhere citing what a past version decided** (`serializers.ts` has carried these). Also history.

A blind `sed` breaks all of them.

## The number can be taken out from under you

Three tickets bumping this one constant in a night is not a conflict to resolve by taking the
highest - they are different changes, so every changelog entry stays and your branch takes the
**next free** number. One branch renumbered twice on the way: built at v1.60.0, which another
ticket took; renumbered to v1.61.0, which a third took; landed at v1.62.0. Another tried four
numbers.

**Re-read the constant on `main` at rebase time** rather than trusting a number that was free
when the branch was cut.

## Sibling versions are independent and must not be bumped along

The verifiers and extractors each carry their own version
(`VERIFY_PROSE_PROMISE_PROMPT_VERSION`,
`EXTRACT_REPORTED_ORDER_PROMPT_VERSION`, and the rest). They never touch the
classify/generate contract, so bumping `PROMPT_VERSION` for a change to one of them is a
false signal - and vice versa.

## Bump means the harness baseline resets

`run-test-scenarios` grades against the composed prompt, so a diff across a bump is a
**baseline reset**, not a regression. Say so when reporting one. A change that alters what a
scenario can raise, or that makes the model hold more drafts, moves routing grades for
reasons unrelated to routing.
