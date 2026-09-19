// TAC-469: the pure halves of the Instagram outbound smoke test, split out so
// they can be tested. The entry script calls main() at the top level, so
// importing it would start a run that sends real messages.
//
// textOfBytes is the one worth testing: check B is a BOUNDARY test, and a
// padding that is one byte out would send 999 where it means 1000 and report
// a pass that proves nothing about the line Meta actually draws.

export type SmokeArgs = {
  venue?: string
  guest?: string
  confirm: boolean
  showIds: boolean
}

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  const out: SmokeArgs = { confirm: false, showIds: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--venue') out.venue = argv[++i]
    else if (arg === '--guest') out.guest = argv[++i]
    else if (arg === '--confirm') out.confirm = true
    else if (arg === '--show-ids') out.showIds = true
  }
  return out
}

/**
 * A message of EXACTLY `bytes` UTF-8 bytes, opening with `label` so a person
 * reading the thread knows what it is. ASCII only, so bytes and characters
 * agree and the count is the thing being tested rather than an accident of
 * the label. Throws rather than return a message of the wrong length: a
 * boundary test built on the wrong length proves nothing.
 */
export function textOfBytes(bytes: number, label: string): string {
  const prefix = `${label} `
  if (Buffer.byteLength(prefix, 'utf8') > bytes) {
    throw new Error(`textOfBytes: the label alone is longer than ${bytes} bytes`)
  }
  const text = prefix + 'a'.repeat(bytes - Buffer.byteLength(prefix, 'utf8'))
  const actual = Buffer.byteLength(text, 'utf8')
  if (actual !== bytes) throw new Error(`textOfBytes: wanted ${bytes}, built ${actual}`)
  return text
}

/** A mid or other identifier, safe to print: the ends only, unless asked. */
export function idForLog(value: string, showIds: boolean): string {
  if (showIds) return value
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`
}
