'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  nextMinorVersion,
  promotionArtifact,
  templateEditHash,
} from '@/lib/ai/v2/promote-template'
import {
  resolveV2TemplateSet,
  type V2TemplateBlocks,
} from '@/lib/ai/v2/template-archive'
import type { StoredSweep } from '../_lib/sweep-store'

// Promote: turn the edited template into the patch that makes it this build's
// own, versioned across the board.
//
// IT WRITES NOTHING AND CANNOT. `lib/ai/v2/template.ts` is source, so no
// deployed code can edit it - and that constraint is also the right design,
// because a promotion changes guest-facing copy at every venue and the gates on
// that (verbatim approval, the regression run, a PR review) all live around a
// commit. `lib/ai/v2/promote-template.ts` builds the document; this is the
// surface, and the only thing it adds is the coverage claim.
//
// PROMOTED MEANS MEASURED, and that is enforced rather than asserted. The
// button needs at least one answer that ran on the EXACT bytes in the editor,
// matched by hash per cell. The artifact then states the count it found, so "1
// of 62" promotes and says so - the gate is that something ran on this text,
// not that everything did. A banner claiming the text was measured would be
// the claim-nothing-enforces shape; a hash comparison is something that can
// fail.

export function PromotePanel({
  templateVersion,
  blocks,
  sweep,
  askable,
  busy,
}: {
  templateVersion: string
  blocks: V2TemplateBlocks
  /** This venue's stored sweep, which is where the coverage count comes from. */
  sweep: StoredSweep | null
  askable: number
  busy: boolean
}) {
  const set = resolveV2TemplateSet(templateVersion)
  const hash = templateEditHash(blocks)
  const suggested = nextMinorVersion(set.version)
  // Null means "no version typed yet", so the suggestion stays live while the
  // selected template version changes underneath it. Typing pins it.
  const [typedVersion, setTypedVersion] = useState<string | null>(null)
  const version = typedVersion ?? suggested ?? ''
  const [copied, setCopied] = useState(false)

  /**
   * Answers on screen, split by whether they ran on the text in the editor.
   *
   * THE SPLIT IS THE WHOLE POINT, and it shipped as a count at first. A bare
   * "nothing ran on this text" is the same sentence whether the template is
   * untouched or was edited after the sweep, and those have opposite fixes -
   * one is "edit something", the other is "run it again". It was also a DEAD
   * END on an unedited template: an untouched edit hashes to `unedited` while
   * every cell records null, so no amount of running could ever satisfy it.
   */
  const { matching, stale } = useMemo(() => {
    const done = Object.values(sweep?.results ?? {}).filter(
      (r) => r.status === 'done',
    )
    return {
      matching: done.filter(
        (r) => r.status === 'done' && r.templateHash === hash,
      ),
      stale: done.filter((r) => r.status === 'done' && r.templateHash !== hash)
        .length,
    }
  }, [sweep, hash])

  /**
   * Built FIRST, before the coverage gate, so an unpromotable edit reports why
   * it is unpromotable rather than being told to go and measure it.
   * `promotionArtifact` refuses an unedited set and an invalid one with its own
   * reasons, and those are the states a coverage count cannot describe.
   */
  const built = useMemo(() => {
    const models = [
      ...new Set(matching.map((r) => (r.status === 'done' ? r.model : ''))),
    ]
    const efforts = [
      ...new Set(
        matching.map((r) =>
          r.status === 'done' ? (r.effort ?? 'none') : 'none',
        ),
      ),
    ]
    return promotionArtifact({
      from: set,
      blocks,
      nextVersion: version,
      coverage: {
        answered: matching.length,
        askable,
        sweptAt: sweep?.startedAt ?? null,
        // Joined rather than picked: a column can hold answers from two models
        // (the sweep store's own header says the cell is the authority, not
        // the header), and a promotion that quietly reported one of them would
        // be the mislabelling this repo keeps paying for.
        modelId: models.join(', '),
        effort: efforts.join(', '),
      },
    })
  }, [set, blocks, version, matching, askable, sweep])

  const result = useMemo(() => {
    if (version === '')
      return {
        ok: false as const,
        error: `${set.version} is not a version this can bump automatically - type the next one.`,
      }
    if (!built.ok) return built
    if (matching.length === 0)
      return {
        ok: false as const,
        error:
          stale === 0
            ? 'nothing has run on this text yet. Run at least one question on it - a promotion is a claim that the copy was tried, and this is the only thing that can check it.'
            : `${stale} ${stale === 1 ? 'answer' : 'answers'} on screen ran on an EARLIER version of this text, which is no evidence about what is in the editor now. Run at least one question again.`,
      }
    return built
  }, [built, version, set.version, matching, stale])

  const onCopy = () => {
    if (!result.ok) return
    void navigator.clipboard.writeText(result.artifact).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  const onDownload = () => {
    if (!result.ok) return
    const blob = new Blob([result.artifact], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `promote-${set.version}-to-${version}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-2 rounded-[2px] border border-stone-light/60 p-3">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">
        promote
      </span>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-ink-faint">next version</span>
        <Input
          value={version}
          onChange={(e) => setTypedVersion(e.target.value)}
          disabled={busy}
          spellCheck={false}
          className="font-mono text-[11px]"
        />
      </div>

      <p className="text-[11px] leading-relaxed text-ink-soft">
        {/* Three states, not two. "Nothing ran on this text" was shown for an
            UNTOUCHED template as well, which read as work to do and was
            unsatisfiable - there is nothing to measure until a block changes. */}
        {Object.keys(blocks).length === 0
          ? `${set.version} as it ships, unedited.`
          : matching.length === 0
            ? 'Nothing on screen ran on this exact text yet.'
            : `${matching.length} of ${askable} questions answered on this exact text.`}
      </p>

      {!result.ok && (
        <p className="text-[11px] leading-relaxed text-clay-deep">
          {result.error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !result.ok}
          onClick={onCopy}
        >
          {copied ? 'Copied' : 'Copy patch'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !result.ok}
          onClick={onDownload}
        >
          Download
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        {/* NO `{expression}` INSIDE THIS SENTENCE. One sat here and rendered
            "v2.23.0-draftarchived": JSX drops the space after an expression
            when the text behind it wraps, and prettier reflows a `{' '}` fix
            straight back out. The version is named in the line above and in
            the field, so the sentence does not need it. */}
        Produces the four edits one promotion needs: the changed constants, the
        version bump with a changelog scaffold, the outgoing version archived as
        a fixture, and its pinned commit in the verbatim check. Nothing is live
        until that is merged and deployed, and the regression run and the
        owner&apos;s verbatim approval both come first - the patch carries that
        checklist.
      </p>
    </div>
  )
}
