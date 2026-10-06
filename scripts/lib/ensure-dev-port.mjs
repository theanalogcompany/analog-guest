// Preflight for `next dev`: refuse to start if the port is already taken.
//
// Next's default is to pick the next free port and print one line about it.
// That is the wrong default here. Twice on 2026-10-05 a dev server wedged
// (Turbopack internal error - it deletes its own filesystem cache and says so
// on the next start), kept LISTENing on 3000 at 140% CPU, accepted connections
// and answered none, and ignored SIGTERM. The replacement server quietly took
// 3001, so the URL everyone had open still pointed at the dead process and the
// symptom read as "the playground hangs" rather than "that server is wedged,
// kill it". Both times the diagnosis cost far more than the fix.
//
// Node's standard library only, no deps: this runs before `next dev` in an
// npm script (scripts/CLAUDE.md - scripts/lib/*.mjs is plain .mjs).

import { createServer } from 'node:net'

const port = Number(process.argv[2] ?? 3000)

function portIsFree(p) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    // Bind the same way Next does, so a listener on either stack is seen.
    server.listen(p, '::')
  })
}

if (await portIsFree(port)) process.exit(0)

process.stderr.write(
  `\n  Port ${port} is already in use, so refusing to start on a different one.\n\n` +
    `  A wedged dev server holds the port while answering nothing, and starting\n` +
    `  beside it on ${port + 1} leaves your browser pointed at the dead one.\n\n` +
    `  Find it:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
    `  Clear it: kill -9 $(lsof -ti:${port} -sTCP:LISTEN)\n\n` +
    `  If it was wedged, also clear the stale bundler cache: rm -rf .next\n\n`,
)
process.exit(1)
