// `npm run dev:worktree` - a dev server whose URL NAMES the checkout it serves.
//
// WHY THIS IS NOT JUST `next dev`. Several worktrees run at once on this
// machine and 3000 is everyone's default, so the second one either refuses to
// start or quietly serves a different branch's code at the URL being tested.
// A branch has been debugged against another branch's server that way. The
// port here is DERIVED FROM THE CHECKOUT DIRECTORY NAME, so it is stable
// across restarts and distinct per worktree without anyone choosing it.
//
// WHY A PROXY AND NOT JUST A HOSTNAME. `*.localhost` resolves to 127.0.0.1
// with no /etc/hosts entry, but the admin surface is host-gated and the local
// auth bypass accepts ONLY a literal `localhost` Host (lib/auth/dev-bypass.ts,
// isLocalhost - and lib/auth is hard-stop, so widening that check is not on
// the table). The proxy therefore carries the readable hostname and rewrites
// Host, and x-forwarded-host which the bypass also consults, back to
// `localhost` before Next sees it. Both ports stay open: the bare
// 127.0.0.1:<devPort> still works for curl and for anything that does not care
// which branch it hit.
//
// ---------------------------------------------------------------------------
// THREE FAILURES THIS SCRIPT USED TO HAVE, all observed in one session on
// 2026-10-08. They chain: (1) kills the process, which strands the child from
// (2), and (3) then starts on top of that orphan and dies. The visible
// symptom of the whole cycle is "the dev server will not start", clearing
// only after someone finds and kills the stranded next-server by hand.
//
// Missing node_modules is a FOURTH way a fresh worktree fails to start, and
// it is NOT handled here - `scripts/ensure-node-modules.mjs` runs ahead of
// this script from the npm script, for both `dev:worktree` and
// `build:worktree`. Do not add a second install path here.
//
// 1. AN UNHANDLED EPIPE KILLED THE WHOLE SERVER. Only `up` carried an error
//    handler. A client that disconnects mid-response - a reload, a cancelled
//    navigation, curl hanging up - makes `r.pipe(res)` write to a dead socket,
//    and node turns an unhandled 'error' event into process death. Every
//    stream in both paths now has a handler, and a vanished client aborts its
//    own upstream request instead of taking the process with it.
//
// 2. THAT CRASH ORPHANED `next dev`. Teardown lived only in the SIGINT/SIGTERM
//    handlers, so an uncaught exception skipped it entirely and left
//    next-server holding the port, reparented to launchd (observed: pid with
//    ppid 1, still LISTEN, long after its parent was gone). Teardown is now on
//    every exit path including 'uncaughtException' and 'exit', with a SIGKILL
//    backstop for a child that ignores SIGTERM.
//
// 3. THE PORT PROBE USED THE WRONG ADDRESS FAMILY. `freePort` bound
//    `127.0.0.1` (IPv4) while next-server binds the IPv6 wildcard - `lsof`
//    shows `IPv6 ... TCP *:3296 (LISTEN)`. So the probe reported "free" on a
//    port an orphan from (2) was holding, and startup died with
//    `EADDRINUSE: :::3296`. The probe now binds exactly what next binds (no
//    host argument, which is node's dual-stack default), and the reservation
//    is HELD until the instant before spawn rather than closed early, which
//    shrinks the check-then-use window from seconds to microseconds.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

const ROOT = process.cwd()

const NAME =
  path
    .basename(ROOT)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'analog'

// FNV-1a. Any stable hash does; this one is short and has no dependency.
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

// --- 3. port reservation ----------------------------------------------------

// Returns a port with its socket STILL BOUND. The caller releases it in the
// instant before the real listener takes over. `listen(p)` with no host is
// node's dual-stack default and is what next-server itself binds, so the probe
// and the real bind can no longer disagree about whether a port is taken.
async function reservePort(start) {
  for (let p = start; p < start + 40; p++) {
    const s = net.createServer()
    const ok = await new Promise((resolve) => {
      s.once('error', () => resolve(false))
      s.once('listening', () => resolve(true))
      s.listen(p)
    })
    if (ok) return { port: p, release: () => new Promise((r) => s.close(r)) }
  }
  throw new Error(`no free port near ${start}`)
}

const slot = hash(NAME) % 300
const devReservation = await reservePort(3200 + slot)
const proxyReservation = await reservePort(3500 + slot)
const devPort = devReservation.port
const proxyPort = proxyReservation.port
const url = `http://${NAME}.localhost:${proxyPort}`

await devReservation.release()
const startedAt = Date.now()
const next = spawn('npx', ['next', 'dev', '--port', String(devPort)], {
  stdio: 'inherit',
  env: { ...process.env, ADMIN_AUTH_DISABLED: '1' },
})

// --- 2. proxy, with every stream handled ------------------------------------

function rewrite(headers) {
  const out = { ...headers, host: `localhost:${devPort}` }
  delete out['x-forwarded-host']
  return out
}

// A disconnected client is routine, not an error worth a stack trace - but it
// MUST be consumed, because an unhandled 'error' on any of these streams takes
// the process down and strands next-server on its port.
const ignore = () => {}

const proxy = http.createServer((req, res) => {
  req.on('error', ignore)
  res.on('error', ignore)

  const up = http.request(
    {
      host: '127.0.0.1',
      port: devPort,
      method: req.method,
      path: req.url,
      headers: rewrite(req.headers),
    },
    (r) => {
      r.on('error', () => res.destroy())
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    },
  )

  // The client gave up: stop pulling bytes we can no longer deliver. Harmless
  // after a clean finish, where 'close' also fires and the request is done.
  res.on('close', () => up.destroy())

  up.on('error', (e) => {
    // Past headers there is no status left to send, so the only honest move is
    // to drop the connection. Writing a second head here used to throw.
    if (res.headersSent || res.writableEnded) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`dev server on ${devPort} not reachable: ${e.message}\n`)
  })

  req.pipe(up)
})

proxy.on('error', (e) => {
  console.error(`  proxy error: ${e.message}`)
})

// Websockets, so HMR survives the proxy.
proxy.on('upgrade', (req, socket, head) => {
  socket.on('error', ignore)
  const up = http.request({
    host: '127.0.0.1',
    port: devPort,
    method: req.method,
    path: req.url,
    headers: rewrite(req.headers),
  })
  up.on('upgrade', (upRes, upSocket, upHead) => {
    upSocket.on('error', ignore)
    const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`)
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`,
    )
    if (upHead.length) socket.unshift(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    socket.on('close', () => upSocket.destroy())
    upSocket.on('close', () => socket.destroy())
  })
  up.on('error', () => socket.destroy())
  if (head.length) up.write(head)
  up.end()
})

await proxyReservation.release()
proxy.listen(proxyPort, () => {
  console.log(`\n  ${NAME}  ${url}`)
  console.log(`  (also 127.0.0.1:${devPort} - same server, no branch name)\n`)
})

// --- 2. teardown on every exit path -----------------------------------------

let shuttingDown = false

function stopNext(signal) {
  if (next.exitCode !== null) return
  try {
    next.kill(signal)
  } catch {
    // Already gone between the check and the kill.
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    proxy.close()
  } catch {
    // Never started, or already closed.
  }
  if (next.exitCode !== null) {
    process.exit(code)
  }
  next.once('exit', () => process.exit(code))
  stopNext('SIGTERM')
  // next dev has been seen ignoring SIGTERM (the wedged-process incident in
  // next.config.ts). Without this backstop that is an orphan holding the port.
  setTimeout(() => {
    stopNext('SIGKILL')
    process.exit(code)
  }, 3000)
}

// SIGHUP is in the list because closing the terminal sends it, and node runs
// no 'exit' handler for a signal it has no listener for - the default action
// terminates the process outright, which is how an orphan survives. SIGKILL
// is the one path nothing can cover; the immediate-exit hint below is what
// catches the orphan it leaves.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => shutdown(0))

process.on('uncaughtException', (e) => {
  console.error('  dev-worktree crashed, shutting the child down with it:')
  console.error(e)
  shutdown(1)
})
process.on('unhandledRejection', (e) => {
  console.error('  dev-worktree unhandled rejection:')
  console.error(e)
  shutdown(1)
})

// Last resort. Only synchronous work runs here, which is why the graceful
// path above exists - but this is what guarantees no orphan on any path.
process.on('exit', () => stopNext('SIGKILL'))

next.on('exit', (code) => {
  if (shuttingDown) return
  // An immediate non-zero exit is almost always a port that lsof says is free
  // and the kernel says is not - i.e. an orphan from a previous crash.
  if ((code ?? 0) !== 0 && Date.now() - startedAt < 5000) {
    console.error(
      `\n  next dev exited immediately. If it said EADDRINUSE, something still holds ${devPort}:\n` +
        `    lsof -nP -i:${devPort}\n`,
    )
  }
  shuttingDown = true
  try {
    proxy.close()
  } catch {
    // Already closed.
  }
  process.exit(code ?? 0)
})
