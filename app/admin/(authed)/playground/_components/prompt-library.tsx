'use client'

import { useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { systemTextOf } from '@/lib/ai/v2/prompt-text'
import {
  deleteSavedPrompt,
  promptsForVenue,
  SAVED_PROMPT_NAME_MAX,
  saveNamedPrompt,
  savedPromptsServerSnapshot,
  savedPromptsSnapshot,
  subscribeSavedPrompts,
} from '../_lib/saved-prompts'

// Save and load hand-edited prompts, per venue, out of this browser's
// localStorage. `_lib/saved-prompts.ts` owns the store and its caps; this is
// only the surface.
//
// IT SAVES THE SYSTEM BLOCKS AND NOT THE TRANSCRIPT. The first version stored
// the whole serialized prompt, so loading one replaced the conversation under
// test with whichever conversation was on screen when it was saved - the turn
// silently became a different input. The house blocks are what an ablation is
// about; the turns are what it is run against, and they belong to the turn.
// `systemTextOf` and `spliceSystemBlocks` (lib/ai/v2/prompt-text.ts) are that
// split.
//
// It reads the store through `useSyncExternalStore`, which is what lets the
// server render an empty list and the client render the real one without a
// hydration mismatch and without an effect that calls setState. A write
// anywhere - including another tab - re-renders this list.

export function PromptLibrary({
  venueId,
  promptVersion,
  text,
  onLoad,
  busy,
}: {
  venueId: string
  /** The version the CURRENT text derives from, stamped onto a save. */
  promptVersion: string
  /** The prompt as it stands in the textarea; Save stores its system half. */
  text: string
  /** Given the SAVED system text; the caller splices it onto its own turns. */
  onLoad: (systemText: string) => void
  busy: boolean
}) {
  const all = useSyncExternalStore(
    subscribeSavedPrompts,
    savedPromptsSnapshot,
    savedPromptsServerSnapshot,
  )
  const entries = useMemo(() => promptsForVenue(all, venueId), [all, venueId])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const existing = entries.find((p) => p.name === name.trim())

  const onSave = () => {
    // Parsed before storing, so an unparseable prompt cannot be saved and then
    // refuse to load later - the refusal happens while the text is still in
    // front of whoever typed it.
    const systemOnly = systemTextOf(text)
    if (!systemOnly.ok) {
      setError(`cannot save - ${systemOnly.error}`)
      return
    }
    const result = saveNamedPrompt({
      name,
      venueId,
      promptVersion,
      text: systemOnly.text,
    })
    setError(result.ok ? null : result.error)
    if (result.ok) setName('')
  }

  return (
    <div className="flex flex-col gap-2 border-t border-stone-light/60 pt-2">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">
        prompt library · house blocks only · this browser only
      </span>

      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name this prompt"
          maxLength={SAVED_PROMPT_NAME_MAX}
          disabled={busy}
          className="h-8 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || name.trim() === ''}
          onClick={onSave}
        >
          {existing !== undefined ? 'Overwrite' : 'Save'}
        </Button>
      </div>
      {existing !== undefined && (
        <span className="text-[11px] text-ink-soft">
          a prompt called &ldquo;{existing.name}&rdquo; is already saved; this
          replaces it
        </span>
      )}
      {error !== null && (
        <span className="text-[11px] text-destructive" role="alert">
          {error}
        </span>
      )}

      {entries.length === 0 ? (
        <span className="text-[11px] italic text-ink-faint">
          Nothing saved for this venue yet. A save keeps the SYSTEM blocks and
          not the transcript, so loading one never changes which conversation
          you are testing. Saved prompts live in this browser only - they
          survive a reload and a regenerate, and nothing else. A prompt worth
          keeping belongs in a PR or in the template.
        </span>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onLoad(p.text)
                  setError(null)
                }}
                className="flex-1 cursor-pointer text-left text-xs text-ink hover:underline disabled:cursor-default disabled:opacity-50"
              >
                {p.name}
                <span className="pl-1.5 text-[11px] text-ink-faint">
                  {p.text.length.toLocaleString()} chars ·{' '}
                  {p.savedAt.slice(0, 10)}
                  {/* The version it came FROM, flagged when the template has
                      moved since - a prompt saved two bumps ago no longer has
                      the frame the changelog describes, and that is invisible
                      from the text. */}
                  {p.promptVersion !== promptVersion && (
                    <span className="pl-1.5 text-clay-deep">
                      saved on {p.promptVersion}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const result = deleteSavedPrompt(p.id)
                  setError(result.ok ? null : result.error)
                }}
                className="cursor-pointer text-[11px] uppercase tracking-wider text-ink-faint hover:text-destructive disabled:cursor-default"
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
