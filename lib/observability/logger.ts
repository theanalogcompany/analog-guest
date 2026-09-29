// Structured logger: one JSON line per event through the console, so
// Vercel's log pipeline (and any future drain) gets level, event and fields
// without parsing prose. Pure by design - no `@/*` imports, no client init -
// so tests import it directly.
//
// Convention for new code: `logger.warn("[area] what happened", { fields })`
// instead of `console.warn(...)`. Existing console call sites migrate as
// they are touched; the event string keeps the old message text so log
// searches keep working across the migration.

type LogFields = Record<string, unknown>
type LogLevel = 'info' | 'warn' | 'error'

// JSON.stringify drops Error properties (they are non-enumerable) and
// throws on circular structures; a logger must never do either.
function safeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  }
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  let line: string
  try {
    line = JSON.stringify(
      { ts: new Date().toISOString(), level, event, ...fields },
      safeReplacer(),
    )
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event })
  }
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (event: string, fields?: LogFields): void =>
    emit('info', event, fields),
  warn: (event: string, fields?: LogFields): void =>
    emit('warn', event, fields),
  error: (event: string, fields?: LogFields): void =>
    emit('error', event, fields),
}
