// TAC-356: universal R30 ("if a guest's message is unclear, ask what they
// mean") is explicitly scoped in its own body to exclude this category — it
// covers content-ambiguity within a message the model would otherwise
// answer directly, not the classifier's own low-confidence routing (TAC-240,
// confidence < 0.3) or the model's own independent choice to route here
// because the message needs operator attention. That is a system-decided
// outcome, and this holding-response contract is the category's real
// behavior, not something R30 should override. Do not read R30 as license
// to have this category ask a clarifying question instead of holding.
export const UNKNOWN_INSTRUCTIONS = `The classifier could not confidently categorize this message, or the message genuinely needs operator attention before a real reply can be written. Your job is a warm holding response in the venue's voice that lets the guest know their message was seen and will be followed up on. Reference what they asked or said so they know it landed and was actually read. Do not promise a specific timeframe unless one is given in the additional context. Do not apologize at length or make it a big deal. Do not invent or guess. It should sound like a real busy person texting back in their own natural voice.`
