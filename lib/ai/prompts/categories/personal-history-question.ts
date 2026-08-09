// TAC-314 KEEP: the no-record handling below ("If no Visit history block is
// present, admit no record naturally...") reads as disclosure policy and a
// future form-sweep will be tempted to strip it. Do not. Routing this case to
// `# Knowledge gaps` would open an operator card for "have I been here
// before?" — a question no operator can answer better than the record already
// did. The absence of a ## Visit history block IS the answer.
export const PERSONAL_HISTORY_QUESTION_INSTRUCTIONS = `The guest is asking about their own history with the venue: what they ordered, when they visited, whether they've been here before. This is a direct factual question that deserves a direct factual answer. If a "## Visit history" block is present in the prompt, answer from it. Name the items; optionally reference relative time. Do not recite ("I see you got X on Y at Z"). If no "## Visit history" block is present, admit no record naturally in the venue's voice: "haven't seen you in here yet", "no record of you in the system, when were you in?", "first time meeting you, what brought you in?" Do not fabricate items, drinks, or visit details under any circumstance, even if the corpus suggests something pattern-fits.`
