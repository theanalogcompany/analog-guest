# Inbound latency plan

**Written:** 2026-09-29, on the `claudechen95/langfuse-sdk-v5-otel` worktree.
**Status:** working document.
Nothing loads this automatically; read it when picking up the latency effort.
Estimates below came from Langfuse span timings on the live pilot traffic during the 2026-09 measurement passes; treat any number here as stale until re-measured.

## Where the pipeline stands

Done as of this document (all on the worktree branch, not yet merged):

- **Jev classification is ON** (`lib/ai/classify-message-jev.ts`), ~150ms against Haiku's ~2.8s, fail-open to Haiku.
- **The five post-generation checks run post-send on inbound** (decision 0003 rewrite, `lib/agent/post-send-checks.ts`), removing the whole verifier batch from the reply path.
  Remediation is a Slack forward for upstream fixing, never a hold.
- **Voice is a static per-venue pack** (decision 0008, `lib/rag/voice-pack.ts`), removing a Voyage embed plus an RPC per turn and the embeddings-down outage mode.
- **Coalesce settle window is zero** (`COALESCE_SETTLE_MS`, decision 0005 run), kept as the rollback lever.

Estimated floor after these: roughly 5 to 6s p50, of which generation is ~4.5 to 5s.
Generation is nearly everything left.

## Remaining items, in rough value order

1. **Generation reasoning brevity.**
   The dominant remaining lever, ~400 to 900ms per attempt.
   The generate schema emits free-form `reasoning` before the body; tightening that instruction is a `PROMPT_VERSION` bump and therefore a repo-wide sweep (`.claude/rules/prompt-versioning.md`).
2. **Voice pack into the cacheable system prefix (phase B of decision 0008).**
   The pack is now identical every turn, so it belongs in the first system block (1h TTL, ~82% hit rate) instead of the volatile second block.
   Also a `PROMPT_VERSION` bump; deliberately kept out of the pack change itself.
3. **Start knowledge retrieval beside classify/context-build**, ~150 to 500ms.
   Same shape as TAC-540's voice move.
   The contextual arm reads `ctx.recentMessages`, so it starts after context-build but need not wait for classify; the tag-preference arm currently waits on classification and needs a ruling on whether to run tagless in parallel instead.
4. **Defer the pre-send Slack awaits and bound `postToSlack`**, ~100 to 400ms typical with an unbounded tail today.
   Move the awaits after dispatch and add `AbortSignal.timeout(3000)`.
5. **Move `updateGuestContext` and arrival-capture dispatch off the critical path**, ~30 to 200ms.
6. **Flatten `computeGuestState`'s four serial DB reads** into one round trip or `Promise.all`, ~20 to 100ms.
7. **Send-theatre parallelization**, ~200 to 570ms: markAsRead, the typing beat, and duplicate venue reads inside the send path.
   Blocked on the TAC-421 product ruling on whether the typing delay is intentional theatre.
8. **Instagram pre-send parallel reads**, ~60 to 250ms on that channel only.
9. **Faster generation model.**
   A product decision (voice quality is the product), not an engineering one; revisit only with a scenario-harness comparison in hand.

Dropped as moot: bounding `verify_grounding` reasoning for latency - it runs post-send now (its output-token cap still matters for correctness, see `lib/tunables/manifest.ts`).

## Ground rules that bound this work

- Voice fidelity floors, retrieval floors and the universal voice rules are the agent runtime contract: plan-gate items, `[PLAN]` first.
- Any prompt change is a `PROMPT_VERSION` sweep and a scenario-harness baseline reset.
- Measure before/after with the Langfuse span timings per stage, not wall-clock anecdotes, and record runs in the PR body, not here.
