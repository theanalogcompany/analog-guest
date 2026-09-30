# 0008 - Voice is a static per-venue pack, not a similarity retrieval

**Date:** 2026-09-29
**Status:** accepted

## Decision

Every generation loads the venue's voice examples the same way for every message:
`loadVoicePack` (`lib/rag/voice-pack.ts`) reads the venue's whole `voice_corpus` and
`selectVoicePack` orders it - `operator_edit` first, newest first, id tiebreak,
`anti_pattern`-tagged excluded - under growth ceilings of 80 entries / 12,000 chars.

There is no query, no embedding, and no similarity score.
The owner's ruling, verbatim in spirit: the shop's voice does not change overnight, and it
does not change with the question - a voice is one consistent style, loaded identically for
every message.

The inbound fail direction survives the rewrite: an empty pack or a failed load still throws
(`retrieveCorpusStage`), because a reply with no venue voice behind it is the product
failing.
Followups and the holding message proceed with whatever loaded.

## Why

Per-message retrieval embedded the guest's message (Voyage) and ranked corpus entries by
cosine (`match_voice_corpus` RPC) - machinery that made sense only if different questions
needed different voices, which the product ruling rejects.

Measured 2026-09-29 across all three live venues, whole corpora are 19-63 entries and
2,640-5,001 chars: **the entire corpus fit inside the old top-8 pack's purpose anyway**, so
retrieval was buying reordering, not selection.
What it cost: one Voyage call plus one RPC of latency on every inbound turn, and an entire
outage mode - embeddings down meant no replies venue-wide, because voice fails closed.

Removed with the mechanism: `retrieveContext`, `STRONG_MATCH_SIMILARITY`,
`MIN_STRONG_MATCHES`, `CORPUS_RETRIEVE_LIMIT`, the `corpus_retrieval_below_threshold`
event, and four tunables-manifest entries.

## What breaks if reversed

Reintroducing per-message voice retrieval reintroduces the Voyage outage mode on the
fail-closed path and the per-turn latency, and it re-couples voice quality to a similarity
score nobody calibrated against voice (cosine tracks query length, not style - the TAC-358
lesson from the knowledge floor).
If a corpus outgrows the ceilings, tune the pack *ordering*, not a per-message query.

## Where it lives

`lib/rag/voice-pack.ts` (selection + ceilings, header carries the measurement),
`lib/agent/stages.ts` `retrieveCorpusStage` (fail direction),
`lib/voices/regenerate-with-critique.ts` (same pack on the operator playground path).
The `match_voice_corpus` RPC (migration 004) and ingest-time voice embedding still exist,
unused at runtime; removing them is optional cleanup.
