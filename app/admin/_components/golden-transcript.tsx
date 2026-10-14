import type { GoldenQuestion } from '@/lib/schemas/golden'

/**
 * What the two engines were actually GIVEN - the authored prior turns, then
 * the guest's message this turn.
 *
 * Rendered rather than summarised, because the answers are unreadable without
 * it. "no record on my end, I only know what you tell me" is either correct or
 * a miss depending entirely on whether the transcript above it mentions an
 * order, and a reader shown only the question cannot tell which.
 *
 * It also renders the turn's own messages, which the header line cannot: on a
 * BURST the header shows `question`, a display label, while the engines were
 * handed `messages`. Showing the label alone would misreport the input.
 *
 * A cold open with a single message renders nothing here - the header already
 * holds that message verbatim - and every caller carries an explicit "cold
 * open" tag so the absence is stated rather than inferred.
 *
 * SHARED BY /admin/tests/golden AND /admin/prompt-lab, which is the whole
 * reason it lives here rather than beside either one. Both surfaces put a v1
 * answer next to a v2 answer, so both owe the reader the same input - and two
 * copies would let one surface quietly stop showing a burst's real messages
 * while the other still did. Pure render off `GOLDEN_QUESTIONS`: no loader, no
 * client JS, safe in a server component and in a client one alike.
 */
export function GoldenTranscript({ question }: { question: GoldenQuestion }) {
  const history = question.history ?? []
  // A PROACTIVE SCENARIO HAS NO MESSAGE THIS TURN. Its `question` is a
  // bracketed descriptor of the occasion ("[Guest said the visit was great];
  // we follow up the next day"), and the `?? [question.question]` fallback
  // below would render that as something the GUEST said - a line in the
  // transcript that was never sent, under the one label that makes a rater
  // read it as the input. The venue writes first here, so the turn is the
  // absence of a guest message.
  const proactive = question.driver === 'proactive'
  const inbound = proactive ? [] : (question.messages ?? [question.question])
  const media = question.mediaUrls ?? []
  // Media counts: a scenario with one text message and a photo would
  // otherwise fall through this guard and render as a plain cold open, which
  // is the input the turn did NOT have.
  if (
    history.length === 0 &&
    inbound.length === 1 &&
    media.length === 0 &&
    !proactive
  )
    return null
  return (
    <div className="flex flex-col gap-1 border-l-2 border-stone-light/60 pl-3">
      {history.map((turn, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          <span className="font-mono uppercase">
            {turn.role === 'user' ? 'guest' : 'venue'}
          </span>{' '}
          {turn.text}
        </p>
      ))}
      {inbound.map((text, i) => (
        <p key={`in-${i}`} className="text-xs">
          <span className="font-mono uppercase text-muted-foreground">
            guest
          </span>{' '}
          {text}
        </p>
      ))}
      {/* The occasion, as an occasion. Neither GUEST nor VENUE, because
          nothing was sent this turn - what the engines were handed is the
          history above plus "it has been a day". */}
      {proactive ? (
        <p className="text-xs italic text-muted-foreground">
          — nothing new from the guest; the venue writes first:{' '}
          {question.question}
        </p>
      ) : null}
      {/* Its own bodyless message, which is how both webhooks store an
          attachment - and the distinction the media path branches on. */}
      {media.length > 0 ? (
        <p className="text-xs">
          <span className="font-mono uppercase text-muted-foreground">
            guest
          </span>{' '}
          <span className="italic text-muted-foreground">
            [attachment, no text] {media.join(' ')}
          </span>
        </p>
      ) : null}
    </div>
  )
}
