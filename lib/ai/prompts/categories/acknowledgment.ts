// TAC-330 (case 2): the KEEP reasoning above held only "by coincidence with
// the current two intentions, not by design" — and the coincidence broke,
// not because a new intention arrived (the scenario the original comment
// anticipated) but because a bare one-word reply to Sana's own question
// classified as `acknowledgment` instead of `reply`, and this category's
// absolute "do not pivot / do not start a new thread" silently out-ranked
// a goal that turn was supposed to be free to raise. "Do not push for a
// return visit" is untouched below — no current mechanism conflicts with
// it, so that half of the original reasoning still holds.
//
// Narrowed rather than deleted (unlike TAC-327's casual_chatter fix, which
// removed pure duplicates of what intentions already said): closing a
// thread genuinely shouldn't wander into unrelated small talk, so the
// register discipline is real and stays for anything not independently
// held as a goal. The carve-out is a standing boundary, not a pointer into
// another file's current mechanism — this category has no business
// knowing what conditions a goal is gated on, only that it has no
// authority to override one.
//
// First draft qualified the ban itself ("do not pivot... on your own
// initiative") and left the carve-out to a trailing disclaimer — caught in
// review as self-contradicting: raising a held goal is exactly as much
// "her own initiative" as inventing a topic from nothing, so the qualifier
// picked the wrong axis and the two sentences needed the model to decide
// which one outranked the other. Fixed by leaving the ban unqualified and
// making the second sentence jurisdictional instead of competing: it
// doesn't argue with the ban, it states what the ban never reached. Also
// caught in review: an early version scoped the carve-out to "whatever the
// rest of this prompt tells you," which would have handed authority back
// to venue_info — the exact content that beat the intention in case 2
// (TAC-330's own half two changed venue_info's mood, not its presence).
// Scoped to a goal specifically, not to anything downstream in the prompt.
//
// One consolidation, no behavior change: the old four clauses ("do not
// pivot... do not push for a return visit... do not start a new thread...
// do not say anything that turns the closer into a fresh exchange") are
// now three — "do not start a new thread" folded into the trailing clause,
// since the two were near-synonyms and nothing else in this file or its
// tests depended on the standalone phrase.
export const ACKNOWLEDGMENT_INSTRUCTIONS = `The guest is wrapping up the thread or signing off without a question or request: "thanks", "ok cool", "got it", "see you tomorrow", a single emoji, etc. This is a close, not an opening. Do not pivot to a new topic, do not push for a return visit, and do not turn the closer into a fresh exchange. This is register guidance, how a close should sound, not authority over whether you act on a goal you're already carrying: that call belongs elsewhere, and this line has no say in it.`
