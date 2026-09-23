// TAC-469 rule 1, made structural: Instagram's constraints (the 24-hour window,
// the 1000-byte cap, the reply check, the Send API) never reach the shared or
// SMS send path. "Branch by channel, don't converge." The tempting shortcut is
// to put the window in shared code and make SMS "always open", and it works
// until someone edits the shared code; then it is an SMS bug nobody predicted.
//
// So the Instagram outbound modules may be imported ONLY by the Instagram arms.
// A new importer fails here and has to be added deliberately, with a reason.
// Source-level on purpose: a behavioural test of the SMS path cannot see an
// import that happens not to run.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')

const INSTAGRAM_OUTBOUND_MODULES = ['window', 'send', 'send-target', 'reply-check'] as const

/** Everything outside lib/messaging/instagram/ allowed to import them. */
const ALLOWED_IMPORTERS = [
  join('lib', 'agent', 'dispatch-instagram-reply.ts'),
  join('lib', 'operator', 'dispatch-instagram-outbound.ts'),
  // TAC-469's one-off smoke test, run by hand against a test account. It is
  // the only thing that can settle whether the Send API's message_id is the
  // echo's mid, which every reconciliation on both arms rests on.
  join('scripts', 'instagram-send-smoke.ts'),
  // The smoke test's own pure half. It imports the send failure-kind UNION as a
  // type, to key a total map deciding which refusals are evidence about the
  // byte cap and which say nothing about it. Declaring that union locally
  // instead would be a second copy of Meta's failure vocabulary, and the
  // totality is the guard: a new kind has to be decided about rather than
  // read as a size refusal, which is the bug that put this entry here.
  join('scripts', 'lib', 'instagram-smoke.ts'),
  // TAC-473. The operator queue and conversation list expose
  // `replyWindowExpiresAt`, so one module has to know the window is 24 hours.
  // It imports INSTAGRAM_WINDOW_MS and nothing else: no send, no send target,
  // no reply check, and it routes nothing.
  //
  // Deliberately ONE entry rather than two. queue.ts and conversations.ts both
  // need the deadline, and giving each its own import would have widened this
  // list twice for one reason. The alternative considered and rejected was
  // computing the 24 hours in SQL inside both RPCs, which needs no entry here
  // at all but puts the constant in two places bound only by a test — the cost
  // this repo already pays for DELIVERED_OUTBOUND_STATUSES. One definition of
  // the window beat one fewer line in this list.
  join('lib', 'operator', 'instagram-fields.ts'),
]

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(path)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
      files.push(relative(ROOT, path))
    }
  }
  for (const dir of ['app', 'lib', 'scripts']) walk(join(ROOT, dir))
  return files
}

function importsInstagramOutbound(file: string, source: string): boolean {
  const inInstagramFolder = file.startsWith(join('lib', 'messaging', 'instagram') + '/')
  return INSTAGRAM_OUTBOUND_MODULES.some((name) => {
    const aliased = new RegExp(`from '@/lib/messaging/instagram/${name}'`)
    const relativeImport = new RegExp(`from '\\./${name}'`)
    return aliased.test(source) || (inInstagramFolder && relativeImport.test(source))
  })
}

describe('Instagram outbound stays on the Instagram side (TAC-469 rule 1)', () => {
  const files = sourceFiles()
  const importers = files
    .filter((file) => importsInstagramOutbound(file, readFileSync(join(ROOT, file), 'utf8')))
    .filter((file) => !file.startsWith(join('lib', 'messaging', 'instagram') + '/'))
    .sort()

  it('is imported outside lib/messaging/instagram only by the Instagram arms', () => {
    expect(importers).toEqual([...ALLOWED_IMPORTERS].sort())
  })

  // Guards the guard: a walk that found nothing would pass the check above
  // with any allow-list at all.
  it('actually sees the files it is guarding', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(join('lib', 'agent', 'schedule-and-send.ts'))
    expect(importers.length).toBeGreaterThan(0)
  })

  it('keeps the shared and SMS send paths free of Instagram', () => {
    for (const file of [
      join('lib', 'agent', 'schedule-and-send.ts'),
      join('lib', 'messaging', 'send.ts'),
      join('lib', 'messaging', 'expressions.ts'),
      join('lib', 'messaging', 'venue-lookup.ts'),
      join('lib', 'messaging', 'index.ts'),
    ]) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(/from '[^']*instagram[^']*'/)
    }
  })

  it('lets the routing switches reach Instagram only through their Instagram arms', () => {
    const agent = readFileSync(join(ROOT, 'lib', 'agent', 'dispatch-reply.ts'), 'utf8')
    expect(agent.match(/from '[^']*instagram[^']*'/g) ?? []).toEqual(["from './dispatch-instagram-reply'"])
    const operator = readFileSync(join(ROOT, 'lib', 'operator', 'dispatch-operator-outbound.ts'), 'utf8')
    expect(operator.match(/from '[^']*instagram[^']*'/g) ?? []).toEqual(["from './dispatch-instagram-outbound'"])
  })

  // An Instagram-only venue has no messaging_phone_number (TAC-469 pre-flight).
  // The Instagram arm must never reach the phone-number provider's transport,
  // its read receipts, or its number lookup, which fails closed without one.
  it.each(ALLOWED_IMPORTERS)('keeps %s off the Sendblue transport and the phone-number lookup', (file) => {
    // Applies to the smoke script too: it must exercise the Instagram path and
    // nothing else, or it would prove the wrong thing.
    const source = readFileSync(join(ROOT, file), 'utf8')
    expect(source).not.toMatch(/from '@\/lib\/messaging'/)
    expect(source).not.toMatch(/from '@\/lib\/messaging\/(send|expressions|venue-lookup|sendblue-client)'/)
    expect(source).not.toContain('messaging_phone_number')
    expect(source).not.toMatch(/\bmarkAsRead\b|\bsendTypingIndicator\b|\bsendMessage\b/)
  })
})
