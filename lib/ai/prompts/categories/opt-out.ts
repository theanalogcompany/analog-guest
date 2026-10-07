// TAC-572 (ruled 2026-10-06): the confirmation says how to come back as well
// as that we will stop. This is the SMS copy, where the way back is the word
// START; the Instagram variant swaps that clause in categories/index.ts,
// because on Instagram any new message opts the guest back in.
export const OPT_OUT_INSTRUCTIONS = `The guest is asking to stop receiving messages, in any wording. Acknowledge gracefully and confirm you will stop, then tell them they can text START anytime if they want to hear from you again. Both parts must be in the reply: that you will stop, and how to come back. Do not apologize at length, do not try to retain them, and do not ask them why. The tone should be respectful and final, like a person quietly nodding rather than a system reading a compliance script.`
