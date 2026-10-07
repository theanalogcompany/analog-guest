// Pure helper for the /admin/health Kimi row, the check-typesafe shape: reads
// env at call time, returns a CheckRow, never throws, never surfaces key
// material (KIMI_API_KEY is entirely secret, so not even a prefix is shown).
//
// Kimi is the LLM-as-judge model for the regression harness and the playground
// inline judge (owner-ruled 2026-10-06). It is deliberately a DIFFERENT model
// family from generation: until this change the same model wrote the reply and
// scored it, which is the self-judging weakness the judge's own trust
// discipline warns about.
//
// Three states. Note that "not configured" is NOT a working state the way the
// Jev row's is - without the key the judge does not run at all, so the tone is
// 'bad' rather than 'neutral':
//
//   1. Not configured — no KIMI_API_KEY. The judge cannot run. tone='bad'.
//   2. Misconfigured  — key present but the wrong shape, per checkKimiEnv.
//                       tone='bad'.
//   3. Key present    — shape ok; detail names the model and base URL in use.
//                       tone='good'.
//
// What this does NOT verify: that the key is accepted by the API. The honest
// confirmation is a 200 from /v1/models, which this row deliberately does not
// make - health must render fast and offline.

import { JUDGE_MODEL_ID } from '@/lib/ai/client'
import { checkKimiEnv, DEFAULT_KIMI_BASE_URL } from '@/lib/ai/kimi-env'

export interface CheckKimiRow {
  label: 'Kimi (judge)'
  detail: string
  tone: 'good' | 'neutral' | 'bad'
}

type EnvLike = Record<string, string | undefined>

export function checkKimi(env: EnvLike = process.env): CheckKimiRow {
  const raw = env.KIMI_API_KEY?.trim() ?? ''

  if (raw === '') {
    return {
      label: 'Kimi (judge)',
      detail: 'Not configured — the LLM judge cannot run',
      tone: 'bad',
    }
  }

  const check = checkKimiEnv(env)
  if (!check.ok) {
    return {
      label: 'Kimi (judge)',
      detail: `Misconfigured — ${check.problems.join(' · ')}`,
      tone: 'bad',
    }
  }

  const base = env.KIMI_BASE_URL?.trim() || DEFAULT_KIMI_BASE_URL
  return {
    label: 'Kimi (judge)',
    detail: `Key present — judging on ${JUDGE_MODEL_ID} at ${base} (key validity unconfirmed)`,
    tone: 'good',
  }
}
