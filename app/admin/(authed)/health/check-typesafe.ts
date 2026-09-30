// Pure helper for the /admin/health TypeSafe (Jev) row, the check-langfuse /
// check-apns shape: reads env at call time, returns a CheckRow, never throws,
// never surfaces key material (JEV_API_KEY is entirely secret, so unlike
// the Langfuse row not even a prefix is shown).
//
// Three states, plus the flag woven into the detail text because the key
// being present does NOT mean Jev is classifying - the flag in
// classify-message-jev.ts gates that independently, and an operator reading
// this row needs to know which model is actually live:
//
//   1. Not configured — no JEV_API_KEY. Classification runs on Haiku;
//                       that is a working state, not a problem. tone='neutral'.
//   2. Misconfigured  — key present but the wrong shape, per checkTypesafeEnv.
//                       tone='bad'.
//   3. Key present    — shape ok. Detail states whether the Jev flag is on
//                       (Jev live, Haiku as fallback) or off (Haiku live).
//                       tone='good'.
//
// What this does NOT verify: that the key is accepted by the API. The honest
// confirmation is a 200 from /v1/models, which this row deliberately does not
// make - health must render fast and offline.

import { JEV_CLASSIFICATION_ENABLED } from '@/lib/ai/classify-message-jev'
import { checkTypesafeEnv } from '@/lib/ai/typesafe-env'

export interface CheckTypesafeRow {
  label: 'TypeSafe (Jev)'
  detail: string
  tone: 'good' | 'neutral' | 'bad'
}

type EnvLike = Record<string, string | undefined>

export function checkTypesafe(
  env: EnvLike = process.env,
  flagEnabled: boolean = JEV_CLASSIFICATION_ENABLED,
): CheckTypesafeRow {
  const raw = env.JEV_API_KEY?.trim() ?? ''

  if (raw === '') {
    return {
      label: 'TypeSafe (Jev)',
      detail: 'Not configured — classification runs on Haiku',
      tone: 'neutral',
    }
  }

  const check = checkTypesafeEnv(env)
  if (!check.ok) {
    return {
      label: 'TypeSafe (Jev)',
      detail: `Misconfigured — ${check.problems.join(' · ')}`,
      tone: 'bad',
    }
  }

  return {
    label: 'TypeSafe (Jev)',
    detail: flagEnabled
      ? 'Key present — Jev classification ON, Haiku as fallback (key validity unconfirmed)'
      : 'Key present — flag off, classification runs on Haiku',
    tone: 'good',
  }
}
