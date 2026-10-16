'use client'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  applyV2TemplateBlocks,
  readV2TemplateBlock,
  resolveV2TemplateSet,
  v2PlaceholdersIn,
  type V2TemplateBlocks,
  type V2TemplateSet,
} from '@/lib/ai/v2/template-archive'

// The TEMPLATE under edit - the blocks as `lib/ai/v2/template.ts` holds them,
// `{placeholders}` and all.
//
// WHY THIS EXISTS BESIDE THE FLAT EDITOR. The flat one edits the composed
// OUTPUT, which is the right instrument for an ablation: every byte the model
// reads, in one box, with nothing to parse. It is the wrong instrument for
// anything meant to be PROMOTED, because the text in it has one venue's data,
// one guest's HOUSE NOTES and one moment's clock baked in and no block
// structure left. V2_PROMPT_VERSION's v2.20.0 entry is the record of what
// promoting that costs: 49,100 chars with no placeholders, of which 44,393
// turned out to be venue data and had to be routed back to the venue's brief
// by hand.
//
// ONE TEXTAREA PER BLOCK, AND NO DELIMITERS ANYWHERE. The owner's "just one
// giant editable system prompt" ruling was about the `<<< SYSTEM: LABEL >>>`
// lines, which were load-bearing: deleting one changed the label set, the diff
// was refused, and the run went out with the composed prompt while the box
// showed an edited one. Separate boxes give back the block structure with
// nothing to parse, so that failure cannot recur here.
//
// IT NEEDS NO RUN TO SEED. A template set is build constants, so this renders
// before a single question has been asked - unlike the flat editor, which can
// only be seeded by composing, and therefore by generating.

export function TemplateEditor({
  templateVersion,
  blocks,
  onBlock,
  onClearAll,
  briefed,
  busy,
}: {
  templateVersion: string
  /** Only the blocks that differ from the version's own text. */
  blocks: V2TemplateBlocks
  onBlock: (key: keyof V2TemplateBlocks, text: string) => void
  onClearAll: () => void
  /**
   * Whether the selected venue has a knowledge brief, so the live block 2 can
   * be named. Null until a question has been run - the honest state, because
   * the answer comes from the venue's own config and this component has no
   * way to know it otherwise.
   */
  briefed: boolean | null
  busy: boolean
}) {
  const set = resolveV2TemplateSet(templateVersion)
  // Validated with the SAME function the turn runner validates with, so the
  // refusal on screen is the refusal that would come back from a run. This is
  // feedback, not enforcement: `run-turn.ts` is what refuses the turn.
  const applied = applyV2TemplateBlocks(set, blocks)
  const editedCount = Object.keys(blocks).length

  return (
    <div className="flex flex-col gap-3">
      {!applied.ok && (
        <p className="rounded-[2px] border border-clay-deep/40 bg-clay-deep/5 px-2 py-1.5 text-[11px] leading-relaxed text-clay-deep">
          {applied.error}
        </p>
      )}

      <Block
        set={set}
        blocks={blocks}
        field="frame"
        label="ROLE"
        note="Block 1. Static across every venue bar its placeholders, and never cached on its own - the breakpoint after block 2 makes the two one prefix."
        onBlock={onBlock}
        busy={busy}
      />
      <Block
        set={set}
        blocks={blocks}
        field="houseSectionsBriefed"
        label="THE HOUSE, briefed"
        live={briefed}
        note="Block 2 for a venue with an authored knowledge brief. The brief itself is venue data and arrives through the placeholder - it is not template copy and does not belong in this box."
        onBlock={onBlock}
        busy={busy}
      />
      <Block
        set={set}
        blocks={blocks}
        field="houseSections"
        label="THE HOUSE, no brief"
        live={briefed === null ? null : !briefed}
        note="Block 2 for a venue with no brief, which is every venue but the pilot. Its content is the rendered venue profile plus the voice pack."
        onBlock={onBlock}
        busy={busy}
      />
      <Block
        set={set}
        blocks={blocks}
        field="guestState"
        label="HOUSE NOTES"
        note="Block 3, rebuilt every turn. The only block a clock-derived or guest-derived line may reach: anything per-turn in block 1 or 2 invalidates the cached prefix in front of it on every single turn. It also goes to the judge as the situation brief."
        onBlock={onBlock}
        busy={busy}
      />

      <details className="rounded-[2px] border border-stone-light/60 px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-ink-faint">
          the outreach lane
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Only the two proactive scenarios compose these. The note fills the
            tail of HOUSE NOTES when the venue is writing first; the cue is the
            fixed synthetic final turn that stands in for the guest&apos;s
            message, and it is machine-authored text rather than anything a
            guest sent.
          </p>
          <Block
            set={set}
            blocks={blocks}
            field="outreachNote"
            label="outreach note"
            onBlock={onBlock}
            busy={busy}
            rows={8}
          />
          <Block
            set={set}
            blocks={blocks}
            field="outreachCue"
            label="outreach cue"
            onBlock={onBlock}
            busy={busy}
            rows={4}
          />
        </div>
      </details>

      <div className="flex items-center gap-3">
        <span className="text-[11px] text-ink-faint">
          {editedCount === 0
            ? `${templateVersion} as it ships`
            : `${editedCount} of 6 blocks edited`}
        </span>
        {editedCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onClearAll}
          >
            Reset all
          </Button>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        Each question composes this template with its own venue data, brief,
        state and clock, so a sweep here measures what would ship. A turn that
        runs on an edit is stamped <code>+hand-edited</code> and is not the
        version it started from.
      </p>
    </div>
  )
}

function Block({
  set,
  blocks,
  field,
  label,
  note,
  live,
  onBlock,
  busy,
  rows = 16,
}: {
  set: V2TemplateSet
  blocks: V2TemplateBlocks
  field: keyof V2TemplateBlocks
  label: string
  note?: string
  /** True when this is the block the selected venue composes; null when unknown. */
  live?: boolean | null
  onBlock: (key: keyof V2TemplateBlocks, text: string) => void
  busy: boolean
  rows?: number
}) {
  const original = readV2TemplateBlock(set, field)

  // A version that does not carry this block says so and offers no box. An
  // edit to it would be refused at the runner anyway - composing a version
  // that never shipped is the thing the archive exists to prevent - and a
  // disabled textarea reads as a box that failed to load.
  if (original === undefined)
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        {/* One expression, not three fragments: JSX drops the space after an
            `{expression}` when the text behind it wraps to the next line, and
            prettier reflows the `{' '}` fix back out. See promote-panel.tsx. */}
        <span className="text-[11px] italic text-ink-faint">
          {`${set.version} has no ${label} block, so there is nothing to edit.`}
        </span>
      </div>
    )

  const edit = blocks[field]
  const text = edit ?? original
  const placeholders = v2PlaceholdersIn(original)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        {live === true && (
          <span className="text-[11px] text-ink-soft">live for this venue</span>
        )}
        {live === false && (
          <span className="text-[11px] text-ink-faint">
            not this venue&apos;s
          </span>
        )}
      </div>
      <Textarea
        value={text}
        onChange={(e) => onBlock(field, e.target.value)}
        disabled={busy}
        rows={rows}
        spellCheck={false}
        className="max-h-[32rem] min-h-40 overflow-y-auto font-mono text-[11px] leading-[1.5]"
      />
      <div className="flex items-center gap-3">
        <span className="text-[11px] tabular-nums text-ink-faint">
          {text.length.toLocaleString()} chars
        </span>
        {edit !== undefined && (
          <>
            <span className="text-[11px] text-clay-deep">edited</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onBlock(field, original)}
            >
              Reset
            </Button>
          </>
        )}
      </div>
      <span className="text-[11px] leading-relaxed text-ink-faint">
        {/* The composer fills a FIXED set per block and a lab edit may not add
            one, so this is the whole vocabulary available in this box. Deleting
            one is a legitimate ablation; a typo is refused by name. */}
        Fills: {placeholders.length === 0 ? 'nothing' : placeholders.join(' ')}
        {note === undefined ? '' : ` · ${note}`}
      </span>
    </div>
  )
}
