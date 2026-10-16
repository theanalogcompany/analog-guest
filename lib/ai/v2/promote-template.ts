import {
  applyV2TemplateBlocks,
  readV2TemplateBlock,
  V2_TEMPLATE_SETS,
  v2PlaceholdersIn,
  type V2TemplateBlocks,
  type V2TemplateSet,
} from './template-archive'

// Promoting a prompt-lab template edit into this build's own template.
//
// WHAT PROMOTION IS HERE: an artifact a human applies, never a live write.
// `lib/ai/v2/template.ts` is source, so no deployed code can edit it, and that
// constraint happens to be the right design anyway - a promotion changes
// guest-facing copy at every venue, and the repo's gates on that (verbatim
// approval, `.claude/rules/v2-template-regression.md`, a PR review) all live
// around a commit. A button that made new copy live would route around every
// one of them.
//
// SO THIS EMITS THE WHOLE EDIT, not just the new copy. Both promotions to date
// (v2.20.0 and v2.22.0) were hand-reconstructed, and the parts most easily
// forgotten are the bookkeeping ones: archiving the OUTGOING version so a
// future turn can still be run on it, and pinning its commit in the verbatim
// check. Those are mechanical, so they are generated rather than remembered.
//
// FOUR EDITS COME OUT OF ONE PROMOTION:
//
//   1. the changed `export const V2_*` bodies in lib/ai/v2/template.ts
//   2. `V2_PROMPT_VERSION`, bumped minor
//   3. the outgoing version as a frozen `V2TemplateSet` in template-archive.ts,
//      plus its line in `V2_TEMPLATE_SETS`
//   4. its pinned SHA in `SOURCES` in
//      scripts/measurement/template-archive-verbatim.ts
//
// THE ARCHIVE ENTRY IS FROZEN LITERALS, never a reference to `V2_FRAME` and
// friends. `V2_TEMPLATE_CURRENT` may read the live exports because it IS
// current; an archived set that did would change the next time anyone promoted,
// which is the one thing the archive exists to prevent. Where a block happens
// to be byte-identical to one the archive already holds, that is reported so
// the reviewer can reference the existing literal instead of pasting a third
// copy - reported, not done, because only a human can see what that literal is
// called.

/**
 * How much of the golden set was actually run on the exact bytes being
 * promoted.
 *
 * NOT optional and NOT a boolean. "This was measured" is the claim a promotion
 * rests on, and a banner asserting it is the claim-nothing-enforces shape this
 * repo keeps paying for - so the caller must produce a count, the count rides
 * into the artifact, and "1 of 62" promotes perfectly well while saying so.
 */
export interface PromotionCoverage {
  answered: number
  askable: number
  /** ISO, from the sweep's own record rather than the moment of promotion. */
  sweptAt: string | null
  modelId: string
  effort: string
}

export interface PromotionInput {
  /** The set the edit was made against - normally `V2_TEMPLATE_CURRENT`. */
  from: V2TemplateSet
  blocks: V2TemplateBlocks
  /** The version to bump to. `nextMinorVersion(from.version)` by default. */
  nextVersion: string
  coverage: PromotionCoverage
}

/**
 * A stable fingerprint of an edit, for deciding whether a sweep's answers
 * belong to the text now on screen.
 *
 * Not a cryptographic hash and not trying to be: nothing adversarial reaches
 * it, and what it has to catch is a human editing one word after sweeping.
 * Canonical by sorted key, so two edits that differ only in the order they
 * were typed in hash the same.
 */
export function templateEditHash(blocks: V2TemplateBlocks): string {
  const keys = Object.keys(blocks).sort()
  if (keys.length === 0) return 'unedited'
  const canonical = JSON.stringify(
    keys.map((k) => [k, blocks[k as keyof V2TemplateBlocks]]),
  )
  // FNV-1a, 32-bit. `>>> 0` after every step because JS bitwise operators
  // return signed 32-bit ints and the multiply overflows into the double
  // range without it.
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * `v2.23.0-draft` to `v2.24.0-draft`. Minor, always (owner-ruled), and the
 * suffix rides along - every version in this family has been a `-draft`, and
 * dropping it on a bump would be a claim about approval that this function is
 * in no position to make.
 *
 * Returns null on a version it cannot read, rather than guessing: the caller
 * shows the field and lets a human type one.
 */
export function nextMinorVersion(version: string): string | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  if (m === null) return null
  return `v${m[1]}.${Number(m[2]) + 1}.0${m[4]}`
}

/** The `export const` each block lives in, for the emitted paste. */
const BLOCK_CONSTANTS = {
  frame: 'V2_FRAME',
  houseSections: 'V2_HOUSE_SECTIONS',
  houseSectionsBriefed: 'V2_HOUSE_SECTIONS_BRIEFED',
  guestState: 'V2_GUEST_STATE',
  outreachNote: 'V2_FOLLOWUP_NOTE',
  outreachCue: 'V2_FOLLOWUP_CUE',
} satisfies Record<keyof V2TemplateBlocks, string>

const BLOCK_LABELS = {
  frame: 'ROLE (block 1)',
  houseSections: 'THE HOUSE, no brief (block 2)',
  houseSectionsBriefed: 'THE HOUSE, briefed (block 2)',
  guestState: 'HOUSE NOTES (block 3)',
  outreachNote: 'the outreach note',
  outreachCue: 'the outreach cue',
} satisfies Record<keyof V2TemplateBlocks, string>

const BLOCK_ORDER = [
  'frame',
  'houseSections',
  'houseSectionsBriefed',
  'guestState',
  'outreachNote',
  'outreachCue',
] satisfies Array<keyof V2TemplateBlocks>

/**
 * Text as a TypeScript template literal body.
 *
 * Backslash FIRST, or the escapes this adds get escaped again. `${` is the
 * third case and the easiest to miss - prompt copy has not carried one yet,
 * and a promotion that introduced one would otherwise paste a file that
 * compiles into something else entirely.
 */
export function escapeTemplateLiteral(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
}

function placeholderList(text: string): string {
  const found = v2PlaceholdersIn(text)
  return found.length === 0 ? 'none' : found.join(' ')
}

/** `v2.23.0-draft` to `V2_TEMPLATE_V2_23_0`, the archive's own naming. */
function archiveConstName(version: string): string {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(version)
  return m === null
    ? `V2_TEMPLATE_${version.replace(/\W/g, '_').toUpperCase()}`
    : `V2_TEMPLATE_V${m[1]}_${m[2]}_${m[3]}`
}

/**
 * Which archived version already holds this exact string for this block, if
 * any. Reported in the artifact so a reviewer can reference the literal the
 * archive has rather than pasting a duplicate - `V2_TEMPLATE_V2_21_0` shares
 * `PRE_V2_20_HOUSE_SECTIONS` with two other keys on exactly this basis.
 */
function alreadyArchivedAs(
  key: keyof V2TemplateBlocks,
  text: string,
  exclude: string,
): string[] {
  return Object.values(V2_TEMPLATE_SETS)
    .filter(
      (s) => s.version !== exclude && readV2TemplateBlock(s, key) === text,
    )
    .map((s) => s.version)
}

export type PromotionResult =
  | { ok: true; artifact: string; changed: Array<keyof V2TemplateBlocks> }
  | { ok: false; error: string }

/**
 * The whole promotion as one markdown document: the paste, the archive entry,
 * the SHA line, a changelog scaffold and the checklist the rules impose.
 *
 * REFUSES an edit the runner would refuse, through the same function rather
 * than through a second opinion about it. An edit that cannot compose cannot
 * have been measured, so there is nothing to promote - and `applyV2TemplateBlocks`
 * is where the reason for the refusal is already written.
 *
 * REFUSES an unedited set too. Promoting nothing would still bump the version
 * and archive the outgoing one, which is a version with no change in it: a
 * fifth key over four wordings is the thing the archive's own ruling was
 * about.
 */
export function promotionArtifact(input: PromotionInput): PromotionResult {
  const applied = applyV2TemplateBlocks(input.from, input.blocks)
  if (!applied.ok) return { ok: false, error: applied.error }
  if (!applied.edited)
    return {
      ok: false,
      error:
        'nothing is edited - every block matches ' +
        `${input.from.version} as it ships, so a promotion would bump the version and archive a set identical to the one before it`,
    }

  const changed = BLOCK_ORDER.filter((key) => {
    const edit = input.blocks[key]
    return edit !== undefined && edit !== readV2TemplateBlock(input.from, key)
  })

  const { from, coverage } = input
  const out: string[] = []

  out.push(`# Promote ${from.version} to ${input.nextVersion}`)
  out.push('')
  out.push(
    `Generated by /admin/prompt-lab. Four edits, all of them in this document. ` +
      `Nothing is live until this is merged and deployed.`,
  )
  out.push('')

  // --- what changed -------------------------------------------------------
  out.push('## What changed')
  out.push('')
  out.push('| block | chars | placeholders after |')
  out.push('| --- | --- | --- |')
  for (const key of changed) {
    const before = readV2TemplateBlock(from, key) ?? ''
    const after = input.blocks[key] ?? ''
    const delta = after.length - before.length
    out.push(
      `| ${BLOCK_LABELS[key]} | ${before.length.toLocaleString()} to ${after.length.toLocaleString()} (${delta >= 0 ? '+' : ''}${delta.toLocaleString()}) | ${placeholderList(after)} |`,
    )
  }
  const untouched = BLOCK_ORDER.filter(
    (k) => !changed.includes(k) && readV2TemplateBlock(from, k) !== undefined,
  )
  out.push('')
  if (untouched.length > 0)
    out.push(`Unchanged: ${untouched.map((k) => BLOCK_LABELS[k]).join(', ')}.`)
  out.push('')
  out.push(
    `A placeholder cannot be ADDED by a lab edit, so the column above is a subset of what ${from.version} already filled per block. ` +
      `Any placeholder missing from it was deleted on purpose and the composer will simply not render it.`,
  )
  out.push('')

  // --- coverage -----------------------------------------------------------
  out.push('## What was measured')
  out.push('')
  out.push(
    `${coverage.answered} of ${coverage.askable} golden questions ran on these exact bytes` +
      (coverage.sweptAt === null ? '' : `, ${coverage.sweptAt}`) +
      `, on ${coverage.modelId} at effort ${coverage.effort}.`,
  )
  out.push('')
  if (coverage.answered < coverage.askable)
    out.push(
      `**${coverage.askable - coverage.answered} questions were not run on this text.** ` +
        `That is a statement about this promotion, not a warning to dismiss - say so in the PR body.`,
    )
  else
    out.push(
      `The whole askable set ran. That is the prompt lab's coverage and not the regression harness's: ` +
        `the golden set is what a guest sends, the harness is what a measured lesson encodes. Both are needed below.`,
    )
  out.push('')
  out.push(
    `The sweep ran ${coverage.modelId}. Every measured lesson in the changelog was taken on the default profile, ` +
      `so if this is not that model, these answers are evidence about this prompt ON THIS MODEL (lib/ai/CLAUDE.md).`,
  )
  out.push('')

  // --- edit 1 + 2: template.ts -------------------------------------------
  out.push('## 1. lib/ai/v2/template.ts')
  out.push('')
  out.push(
    'Replace each constant below in full. The bodies are already escaped for a template literal.',
  )
  out.push('')
  for (const key of changed) {
    out.push(`### ${BLOCK_CONSTANTS[key]} - ${BLOCK_LABELS[key]}`)
    out.push('')
    out.push('```ts')
    out.push(
      `export const ${BLOCK_CONSTANTS[key]} = \`${escapeTemplateLiteral(input.blocks[key] ?? '')}\``,
    )
    out.push('```')
    out.push('')
  }
  out.push('## 2. V2_PROMPT_VERSION')
  out.push('')
  out.push('```ts')
  out.push(`export const V2_PROMPT_VERSION = '${input.nextVersion}'`)
  out.push('```')
  out.push('')
  out.push(
    `A changelog entry goes above it, in the file's own form. Scaffold, with the parts no tool can know left blank:`,
  )
  out.push('')
  out.push('```')
  out.push(
    `// ${input.nextVersion} (owner-??? <date>): <one line on what the copy now does>.`,
  )
  out.push(`// Promoted out of /admin/prompt-lab, where it was edited as the`)
  out.push(
    `// TEMPLATE - placeholders intact, composed per venue per turn - so`,
  )
  out.push(`// what the sweep answered is what this ships.`)
  out.push('//')
  out.push(`// CHANGED: ${changed.map((k) => BLOCK_LABELS[k]).join(', ')}.`)
  out.push(
    `// MEASURED: ${coverage.answered}/${coverage.askable} golden questions on ${coverage.modelId}, effort ${coverage.effort}.`,
  )
  out.push(`//`)
  out.push(
    `// WHAT IT OVERRIDES: <any measured lesson in this file that this copy`,
  )
  out.push(
    `// reverses, named, with the owner's ruling against its evidence. If none,`,
  )
  out.push(
    `// say that outright - an entry with no such paragraph reads as one`,
  )
  out.push(`// nobody checked.>`)
  out.push('```')
  out.push('')

  // --- edit 3: the archive ------------------------------------------------
  const constName = archiveConstName(from.version)
  out.push('## 3. lib/ai/v2/template-archive.ts')
  out.push('')
  out.push(
    `${from.version} stops being this build's template, so it becomes a fixture. ` +
      `Frozen literals, never a reference to the live exports - those are about to change.`,
  )
  out.push('')
  out.push('```ts')
  out.push(`/**`)
  out.push(
    ` * ${from.version} at <SHA of the commit BEFORE this promotion> - the version`,
  )
  out.push(` * ${input.nextVersion} replaces, and the BASELINE for it.`)
  out.push(` */`)
  out.push(`const ${constName}: V2TemplateSet = {`)
  out.push(`  version: '${from.version}',`)
  for (const key of [
    'frame',
    'houseSections',
    'houseSectionsBriefed',
    'guestState',
  ] as const) {
    const text = readV2TemplateBlock(from, key)
    if (text === undefined) continue
    const shared = alreadyArchivedAs(key, text, from.version)
    if (shared.length > 0)
      out.push(
        `  // Byte-identical to ${shared.join(' and ')} - reference the literal the archive already holds instead of this copy.`,
      )
    out.push(`  ${key}: \`${escapeTemplateLiteral(text)}\`,`)
  }
  out.push(`  usesRetrieval: ${String(from.usesRetrieval)},`)
  if (from.outreach !== undefined) {
    out.push(`  outreach: {`)
    out.push(`    note: \`${escapeTemplateLiteral(from.outreach.note)}\`,`)
    out.push(`    cue: \`${escapeTemplateLiteral(from.outreach.cue)}\`,`)
    out.push(`  },`)
  }
  out.push(`}`)
  out.push('```')
  out.push('')
  out.push('Then its line in the registry, newest first:')
  out.push('')
  out.push('```ts')
  out.push(`  [${constName}.version]: ${constName},`)
  out.push('```')
  out.push('')
  out.push(
    `The registry's header states how deep the archive is and why each key earns its place. ` +
      `Adding this one makes it ${Object.keys(V2_TEMPLATE_SETS).length + 1} keys - update that paragraph, ` +
      `and say which key you are dropping if you drop one.`,
  )
  out.push('')

  // --- edit 4: the verbatim check ----------------------------------------
  out.push('## 4. scripts/measurement/template-archive-verbatim.ts')
  out.push('')
  out.push(
    `The new fixture claims to copy a commit. Pin it in \`SOURCES\` so that claim can fail. ` +
      `The SHA is the commit BEFORE this promotion, never HEAD - a check against HEAD passes trivially ` +
      `on the commit that writes the fixture.`,
  )
  out.push('')
  out.push('```ts')
  out.push(
    `  '${from.version}': '<git rev-parse HEAD, before the promotion commit>',`,
  )
  out.push('```')
  out.push('')

  // --- the gates ----------------------------------------------------------
  out.push('## Before this merges')
  out.push('')
  out.push(
    '- [ ] The new copy is approved **verbatim** by the owner. It is guest-facing at every venue.',
  )
  out.push(
    `- [ ] \`npm run measure-template-regression\` has run on ${input.nextVersion}, and the scenario verdicts, breaches with attributions and judge-axis means are in the PR body. The run log path alone is not a report (.claude/rules/v2-template-regression.md).`,
  )
  out.push(
    '- [ ] Every CEILING breach is fixed, or ruled on by the owner in the PR.',
  )
  out.push(
    '- [ ] `npm run verify-template-archive` passes, which is what proves edit 3 and edit 4 agree with git.',
  )
  out.push(
    '- [ ] If this copy carries a measured lesson, `REGRESSION_SCENARIOS` gains a scenario for it in the same PR - a lesson that lives only as a comment is one rewrite away from silently undone.',
  )
  out.push(
    '- [ ] `npx tsc --noEmit`, `npm run lint`, `npx prettier --check .`, `npx jscpd`, `npm run build`.',
  )
  out.push('')

  return { ok: true, artifact: out.join('\n'), changed }
}
