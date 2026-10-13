'use client'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  V2_EFFORT_REQUESTS,
  V2_GENERATE_MAX_OUTPUT_TOKENS,
  V2_MODEL_KEYS,
  V2_MODEL_PROFILES,
  V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
} from '@/lib/ai/v2/model-call'
import {
  V2_TEMPLATE_CURRENT,
  V2_TEMPLATE_VERSIONS,
} from '@/lib/ai/v2/template-archive'
import { PromptLibrary } from '../../playground/_components/prompt-library'

// The prompt under test, plus the parameters the call is made with.
//
// ONE PLAIN TEXTAREA, NO DELIMITERS (owner-ruled 2026-10-13: "just one giant
// editable system prompt"). The composer builds three system blocks and the
// playground edits them per block, by label. This does not: whatever is in
// this box is sent as the entire system half, through the `systemText`
// override. `replaceSystemText` in lib/ai/v2/prompt-text.ts says what that
// costs.
//
// WHY THAT IS THE RIGHT TRADE HERE AND NOT IN THE PLAYGROUND. The per-block
// format needed a `<<< SYSTEM: LABEL >>>` line to mark where a block started,
// and that line was load-bearing: deleting one changed the label set, the diff
// was refused, and the run went out with the COMPOSED prompt while this box
// showed an edited one. That whole failure class goes with the delimiters.
// What is given up is knowing which of three sources a line came from -
// template code, venue data, or the per-turn brief - which the playground
// still shows when that is the question.
//
// THE EDITOR SEEDS FROM AN ANSWERED QUESTION, not from a compose-only
// endpoint. `runTurn` builds the sections and composes in one pass, so a
// "compose without generating" route would be a second path through the same
// loading code and a second chance for the two to disagree about what the
// prompt is. It is kept in localStorage per venue + template version after
// that, so a reload does not empty the box.

export function PromptPane({
  venueId,
  composedSystemText,
  systemText,
  onSystemText,
  promptName,
  onPromptName,
  templateVersion,
  onTemplateVersion,
  modelKey,
  onModelKey,
  effort,
  onEffort,
  maxOutputTokens,
  onMaxOutputTokens,
  busy,
}: {
  venueId: string | null
  /** The composer's own text; '' until one run has landed for this venue. */
  composedSystemText: string
  /** The operator's edit, or null while it is still the composed text. */
  systemText: string | null
  onSystemText: (text: string | null) => void
  promptName: string
  onPromptName: (name: string) => void
  templateVersion: string
  onTemplateVersion: (v: string) => void
  modelKey: string
  onModelKey: (v: string) => void
  effort: string
  onEffort: (v: string) => void
  maxOutputTokens: number
  onMaxOutputTokens: (v: number) => void
  busy: boolean
}) {
  const editing = systemText ?? composedSystemText
  const profile = V2_MODEL_PROFILES[modelKey as keyof typeof V2_MODEL_PROFILES]

  return (
    <div className="flex flex-col gap-3 p-4">
      <Field label="template version">
        <Select
          value={templateVersion}
          onValueChange={onTemplateVersion}
          disabled={busy}
        >
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {V2_TEMPLATE_VERSIONS.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
                {v === V2_TEMPLATE_CURRENT.version
                  ? ' (this build)'
                  : ' (archived fixture)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="model">
        <Select value={modelKey} onValueChange={onModelKey} disabled={busy}>
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {V2_MODEL_KEYS.map((k) => (
              <SelectItem key={k} value={k}>
                {V2_MODEL_PROFILES[k].id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="thinking effort">
        <Select value={effort} onValueChange={onEffort} disabled={busy}>
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {V2_EFFORT_REQUESTS.filter(
              // `.some` and not `.includes`: `allowedEfforts` is narrower than
              // the request list (a profile may not accept every level), and
              // `includes` would refuse the wider argument outright.
              (e) =>
                e === 'none' || profile.allowedEfforts.some((a) => a === e),
            ).map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="max output tokens">
        <input
          type="number"
          min={100}
          max={V2_PLAYGROUND_MAX_OUTPUT_TOKENS}
          step={100}
          value={maxOutputTokens}
          onChange={(e) =>
            onMaxOutputTokens(Number.parseInt(e.target.value, 10))
          }
          disabled={busy}
          className="w-full rounded-[3px] border border-stone-light bg-paper px-2 py-1 font-mono text-[11px] tabular-nums text-ink disabled:opacity-50"
        />
        <span className="text-[11px] text-ink-faint">
          production sends {V2_GENERATE_MAX_OUTPUT_TOKENS.toLocaleString()}
        </span>
      </Field>

      <Field label="system prompt">
        {composedSystemText === '' ? (
          <span className="text-[11px] italic text-ink-faint">
            Run any question on the right to load this venue&apos;s composed
            prompt. It is built by the same pass that generates, so there is no
            cheaper way to get the real one - and it is kept after that, so this
            is a one-time cost per venue.
          </span>
        ) : (
          <>
            <Textarea
              value={editing}
              onChange={(e) => onSystemText(e.target.value)}
              disabled={busy}
              rows={22}
              spellCheck={false}
              className="max-h-[36rem] min-h-72 overflow-y-auto font-mono text-[11px] leading-[1.5]"
            />
            <div className="flex items-center gap-3">
              <span className="text-[11px] tabular-nums text-ink-faint">
                {editing.length.toLocaleString()} chars
              </span>
              {systemText !== null && (
                <>
                  <span className="text-[11px] text-clay-deep">edited</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      onSystemText(null)
                      onPromptName('')
                    }}
                  >
                    Reset
                  </Button>
                </>
              )}
            </div>
            {/* The transcript is NOT in this box and cannot be reached from
                it. The guest's words are the turn's input; a surface that let
                them be rewritten in the same place as the house copy is how a
                reply gets read as an answer to a question nobody asked. */}
            <span className="text-[11px] leading-relaxed text-ink-faint">
              Sent as the whole system half. The guest&apos;s message and the
              scenario&apos;s history are not editable here - each question
              brings its own.
            </span>
          </>
        )}
      </Field>

      {venueId !== null && composedSystemText !== '' && (
        <PromptLibrary
          venueId={venueId}
          promptVersion={templateVersion}
          text={editing}
          serialization="plain"
          onLoad={(saved, name) => {
            onSystemText(saved)
            // The name rides onto the sweep arm, so a stored sweep says which
            // saved prompt produced it rather than only that it was edited.
            onPromptName(name)
          }}
          busy={busy}
        />
      )}
      {promptName !== '' && (
        <span className="text-[11px] text-ink-soft">
          loaded from &ldquo;{promptName}&rdquo;
        </span>
      )}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      {children}
    </div>
  )
}
