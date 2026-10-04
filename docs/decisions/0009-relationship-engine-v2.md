# 0009 - behaviour is three versioned data artifacts, not code

2026-10-03 · accepted · supersedes the intention system, the recognition bands, and the rules-list prompt

**Decision.**
The agent's behaviour is defined by three versioned, eval-iterable data artifacts: the relationship graph (states with prompt-facing missions, plus moves), the prompt template, and the judge rubric.
Code enforces only what a single model call cannot own: concurrency (coalescing, spacing), law (TCPA opt-out), and money (the structural-actions lane plus the Jev policy gate).
Etiquette - when to ask, when to stay quiet, how to phrase, how to split bubbles - belongs to the model, informed by the interaction memory and measured by the six-axis judge on every response.

**Why.**
The v1 systems hardcoded relationship stages as proxies (reply-count staggers, first-conversation suppression, 39 positional prompt rules, 19 approval triggers, four separate verifier calls) and every refinement meant more code, more prompt rules, and linear latency growth.
Facts-in, judgment-by-model inverts that: the old mechanisms' *information* (what was asked, what went unanswered) stays available as rendered facts; their *decisions* move to the model; their *enforcement* moves to the judge, whose calibration set contains the v1 failure transcripts.

**What breaks if reversed.**
Reintroducing per-behaviour code or prompt rules recreates the ratchet: each rule is invisible to the eval loop, competes positionally with its neighbours, and cannot be venue-tuned or A/B-promoted as data.
Moving volatile guest data into the system prompt breaks prompt caching for the whole conversation history.
Relying on the semantic check without the structural actions lane leaves commitments unexecutable (no ledger row) and makes one probabilistic check the only line in front of money.

**Where it lives.**
`lib/relationship/CLAUDE.md` is the architecture; `lib/relationship/schema.ts` and `default-graph.ts` are the graph contract and seed; migration 067 is the storage.
