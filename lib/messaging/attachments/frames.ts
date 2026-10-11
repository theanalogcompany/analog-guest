// TAC-584: a guest's photo or video, as images a model can be shown.
//
// The vision call takes JPEG, PNG, GIF or WebP, a few megabytes each. A phone
// photo is routinely larger than that and a video is not an image at all. So
// every attachment goes through ffmpeg first: a photo is scaled down to one
// JPEG, a video becomes up to four JPEG frames from across the clip.
//
// WHY ffmpeg AND NOT A VIDEO SERVICE (decided on TAC-584's plan). A story can
// be a video, and Meta forbids keeping a story (owner ruling 2026-10-11). A
// hosted service makes thumbnails from a copy it has ingested, which is
// keeping it, somewhere else. ffmpeg runs here, on bytes this function
// already holds, and leaves nothing behind.
//
// WHAT TOUCHES A DISK.
//   A photo or GIF  nothing. Piped in on stdin, read back on stdout.
//   A video         one file in the function's temp directory, for the length
//                   of this call. An MP4's index can sit at the end of the
//                   file, so ffmpeg has to seek and a pipe cannot. The
//                   directory is removed in a `finally`. For a story video
//                   this is the only moment its bytes are on a disk, and that
//                   was put to the owner and approved (plan, default 4).
//
// THE BINARY IS A DEPENDENCY THAT CAN BE MISSING. `ffmpeg-static` downloads it
// at install time and Next has to be told to carry it into the deployment
// (next.config.ts). Either can fail without failing a build, so:
//   - every function here returns an error value and never throws;
//   - a photo already small enough is passed through untouched when ffmpeg
//     cannot run (passThroughImage), so the common case survives it;
//   - /admin/health runs `ffmpeg -version` and says so (check-ffmpeg.ts).
//
// AUDIO IS IGNORED. A voice note is not described and a video's sound is not
// read (the ticket's scope).

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import ffmpegStatic from 'ffmpeg-static'

/** The long side every image is scaled down to. Never scaled up. */
export const MAX_IMAGE_EDGE_PX = 1568

/** Where in the clip each frame is taken, as a fraction of its length. Four frames. */
export const VIDEO_FRAME_POSITIONS: readonly number[] = [0.1, 0.35, 0.6, 0.85]

/**
 * The most an image may weigh to be sent as it arrived, when ffmpeg cannot
 * run. The model API's ceiling is on the base64 form, which is a third
 * larger than the bytes.
 */
export const MAX_PASS_THROUGH_BYTES = 3_500_000

const FFMPEG_TIMEOUT_MS = 20_000
/** A scaled JPEG is a few hundred kilobytes. This is the stop, not the target. */
const MAX_FRAME_BYTES = 8_000_000

const PASS_THROUGH_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]

export type ModelImageType =
  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/** One image, in a form the vision call takes. */
export type Frame = {
  bytes: Uint8Array
  mediaType: ModelImageType
}

export type FramesFailure =
  /** the binary is missing or will not start */
  | 'ffmpeg_unavailable'
  /** ffmpeg ran and produced nothing usable */
  | 'ffmpeg_failed'
  /** nothing ffmpeg or the model can read */
  | 'unsupported_type'

export type FramesResult =
  { ok: true; frames: Frame[] } | { ok: false; error: FramesFailure }

/** The bundled binary's path, or null when the package resolved to nothing. */
export function ffmpegBinaryPath(): string | null {
  return typeof ffmpegStatic === 'string' && ffmpegStatic !== ''
    ? ffmpegStatic
    : null
}

type RunResult =
  | { ok: true; stdout: Uint8Array; stderr: string }
  | { ok: false; error: 'ffmpeg_unavailable' | 'ffmpeg_failed'; stderr: string }

// One ffmpeg process. Never rejects: a spawn error, a non-zero exit, a
// timeout and an oversized output are all values.
function runFfmpeg(
  args: readonly string[],
  stdin: Uint8Array | null,
  // A probe (`-i file` with no output) exits 1 by design and its answer is on
  // stderr, so the caller says whether the exit code is the verdict.
  options: { exitCodeMatters: boolean } = { exitCodeMatters: true },
): Promise<RunResult> {
  const binary = ffmpegBinaryPath()
  if (binary === null) {
    return Promise.resolve({
      ok: false,
      error: 'ffmpeg_unavailable',
      stderr: 'ffmpeg-static resolved to no path',
    })
  }
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: RunResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const child = spawn(binary, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: FFMPEG_TIMEOUT_MS,
    })
    const out: Buffer[] = []
    let outBytes = 0
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.byteLength
      if (outBytes > MAX_FRAME_BYTES) {
        child.kill('SIGKILL')
        settle({
          ok: false,
          error: 'ffmpeg_failed',
          stderr: 'output too large',
        })
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // Enough to hold the header a probe is read from, and no more.
      if (stderr.length < 16_000) stderr += chunk.toString('utf8')
    })
    child.on('error', (e) => {
      settle({ ok: false, error: 'ffmpeg_unavailable', stderr: e.message })
    })
    child.on('close', (code) => {
      if (options.exitCodeMatters && code !== 0) {
        settle({ ok: false, error: 'ffmpeg_failed', stderr })
        return
      }
      settle({ ok: true, stdout: new Uint8Array(Buffer.concat(out)), stderr })
    })
    // A process that dies before it has read its input closes the pipe under
    // the write; that is the 'close' handler's failure, not a crash here.
    child.stdin.on('error', () => {})
    if (stdin !== null) child.stdin.end(Buffer.from(stdin))
    else child.stdin.end()
  })
}

// Scale so the long side is at most MAX_IMAGE_EDGE_PX, never up, keeping the
// shape. One frame, as JPEG, on stdout.
const SCALE_FILTER = `scale='min(${MAX_IMAGE_EDGE_PX},iw)':'min(${MAX_IMAGE_EDGE_PX},ih)':force_original_aspect_ratio=decrease`

const ONE_JPEG_TO_STDOUT: readonly string[] = [
  '-frames:v',
  '1',
  '-vf',
  SCALE_FILTER,
  '-f',
  'image2pipe',
  '-vcodec',
  'mjpeg',
  '-q:v',
  '4',
  'pipe:1',
]

function baseType(mimeType: string | null): string {
  return (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

function isModelImageType(type: string): type is ModelImageType {
  return PASS_THROUGH_TYPES.includes(type)
}

/**
 * An image as it arrived, when it is already something the model takes and
 * small enough to send. Pure. What a photo falls back to when ffmpeg cannot
 * run, so a missing binary costs large photos and videos and not every photo.
 */
export function passThroughImage(
  bytes: Uint8Array,
  mimeType: string | null,
): Frame | null {
  const type = baseType(mimeType)
  if (!isModelImageType(type)) return null
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PASS_THROUGH_BYTES) {
    return null
  }
  return { bytes, mediaType: type }
}

/**
 * A photo or GIF as one scaled JPEG. A GIF gives its first frame.
 *
 * Nothing is written to disk. Never throws.
 */
export async function imageToFrame(
  bytes: Uint8Array,
  mimeType: string | null,
): Promise<FramesResult> {
  const run = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      ...ONE_JPEG_TO_STDOUT,
    ],
    bytes,
  )
  if (run.ok && run.stdout.byteLength > 0) {
    return {
      ok: true,
      frames: [{ bytes: run.stdout, mediaType: 'image/jpeg' }],
    }
  }
  const asArrived = passThroughImage(bytes, mimeType)
  if (asArrived !== null) return { ok: true, frames: [asArrived] }
  if (!run.ok && run.error === 'ffmpeg_unavailable') {
    return { ok: false, error: 'ffmpeg_unavailable' }
  }
  return {
    ok: false,
    error: isModelImageType(baseType(mimeType))
      ? 'ffmpeg_failed'
      : 'unsupported_type',
  }
}

/**
 * A clip's length in seconds from ffmpeg's own header line, or null. Pure,
 * and exported for the harness.
 *
 *   Duration: 00:00:07.43, start: 0.000000, bitrate: 2412 kb/s
 *
 * `N/A` (a stream with no known length) and a zero length are both null: the
 * caller then takes a single frame from the start.
 */
export function parseDurationSeconds(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (match === null) return null
  const seconds =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * Where to take the frames, in seconds. Pure, and exported for the harness.
 *
 * A clip of unknown length gives one frame at its start: a guess at four
 * offsets into a clip that may be one second long returns nothing for most of
 * them.
 */
export function frameTimestamps(durationSeconds: number | null): number[] {
  if (durationSeconds === null) return [0]
  return VIDEO_FRAME_POSITIONS.map(
    (position) => Math.round(durationSeconds * position * 100) / 100,
  )
}

/**
 * A video as up to four scaled JPEG frames from across the clip.
 *
 * Writes the clip to one temp file and removes it before returning, whatever
 * happened (see this file's header). Never throws.
 */
export async function videoToFrames(bytes: Uint8Array): Promise<FramesResult> {
  if (ffmpegBinaryPath() === null) {
    return { ok: false, error: 'ffmpeg_unavailable' }
  }
  let dir: string | null = null
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'guest-media-'))
    const file = path.join(dir, 'clip')
    await writeFile(file, bytes)

    const probe = await runFfmpeg(['-hide_banner', '-i', file], null, {
      exitCodeMatters: false,
    })
    if (!probe.ok) return { ok: false, error: probe.error }

    const frames: Frame[] = []
    for (const at of frameTimestamps(parseDurationSeconds(probe.stderr))) {
      const run = await runFfmpeg(
        [
          '-hide_banner',
          '-loglevel',
          'error',
          // Before `-i`: seek in the input, which is fast and close enough
          // for "a frame from about here".
          '-ss',
          String(at),
          '-i',
          file,
          ...ONE_JPEG_TO_STDOUT,
        ],
        null,
      )
      if (run.ok && run.stdout.byteLength > 0) {
        frames.push({ bytes: run.stdout, mediaType: 'image/jpeg' })
      }
    }
    return frames.length > 0
      ? { ok: true, frames }
      : { ok: false, error: 'ffmpeg_failed' }
  } catch {
    return { ok: false, error: 'ffmpeg_failed' }
  } finally {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export type FfmpegCheck =
  { ok: true; version: string } | { ok: false; error: string }

/**
 * Does the bundled binary run. What /admin/health shows.
 *
 * This RUNS it, on purpose: "the package is installed" and "the path exists"
 * are both true of a deployment whose binary was left out of the bundle.
 */
export async function checkFfmpegRuns(): Promise<FfmpegCheck> {
  if (ffmpegBinaryPath() === null) {
    return { ok: false, error: 'ffmpeg-static resolved to no binary path' }
  }
  const run = await runFfmpeg(['-version'], null)
  if (!run.ok) {
    return {
      ok: false,
      error:
        run.error === 'ffmpeg_unavailable'
          ? `the binary would not start: ${run.stderr.slice(0, 160)}`
          : 'the binary exited with an error',
    }
  }
  const firstLine = new TextDecoder().decode(run.stdout).split('\n')[0] ?? ''
  const version = /ffmpeg version (\S+)/.exec(firstLine)?.[1]
  return version === undefined
    ? { ok: false, error: 'the binary ran and did not report a version' }
    : { ok: true, version }
}
