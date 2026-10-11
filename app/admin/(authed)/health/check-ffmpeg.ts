// The /admin/health row for the bundled ffmpeg binary (TAC-584).
//
// WHY THIS EXISTS. Describing a guest's photo or video goes through ffmpeg
// (lib/messaging/attachments/frames.ts), and the binary reaches a deployment
// by two steps that can each fail without failing a build: `ffmpeg-static`
// downloads it at install time, and next.config.ts tells Next to carry it
// into the function. When it is missing nothing breaks loudly: small photos
// are still described as they arrived, large photos and every video quietly
// fall back to the blank card. This row is how that is noticed.
//
// IT RUNS THE BINARY. Unlike the env rows beside it, which check shape only,
// "is the file there" is not the question: the question is whether it starts
// on this machine. `ffmpeg -version` is a few milliseconds.
//
// Never throws: checkFfmpegRuns returns a value on every path.

import { checkFfmpegRuns } from '@/lib/messaging/attachments/frames'

export interface CheckFfmpegRow {
  label: 'ffmpeg (guest media)'
  detail: string
  tone: 'good' | 'neutral' | 'bad'
}

export async function checkFfmpeg(): Promise<CheckFfmpegRow> {
  const check = await checkFfmpegRuns()
  if (!check.ok) {
    return {
      label: 'ffmpeg (guest media)',
      detail: `Not running — ${check.error}. Videos and large photos are not being described.`,
      tone: 'bad',
    }
  }
  return {
    label: 'ffmpeg (guest media)',
    detail: `Runs (version ${check.version})`,
    tone: 'good',
  }
}
