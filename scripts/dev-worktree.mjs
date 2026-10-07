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
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

const NAME =
  path
    .basename(process.cwd())
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

async function freePort(start) {
  for (let p = start; p < start + 40; p++) {
    const open = await new Promise((resolve) => {
      const s = net
        .createServer()
        .once('error', () => resolve(false))
        .once('listening', () => s.close(() => resolve(true)))
        .listen(p, '127.0.0.1')
    })
    if (open) return p
  }
  throw new Error(`no free port near ${start}`)
}

const slot = hash(NAME) % 300
const devPort = await freePort(3200 + slot)
const proxyPort = await freePort(3500 + slot)
const url = `http://${NAME}.localhost:${proxyPort}`

const next = spawn('npx', ['next', 'dev', '--port', String(devPort)], {
  stdio: 'inherit',
  env: { ...process.env, ADMIN_AUTH_DISABLED: '1' },
})

function rewrite(headers) {
  const out = { ...headers, host: `localhost:${devPort}` }
  delete out['x-forwarded-host']
  return out
}

const proxy = http.createServer((req, res) => {
  const up = http.request(
    {
      host: '127.0.0.1',
      port: devPort,
      method: req.method,
      path: req.url,
      headers: rewrite(req.headers),
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    },
  )
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`dev server on ${devPort} not reachable: ${e.message}\n`)
  })
  req.pipe(up)
})

// Websockets, so HMR survives the proxy.
proxy.on('upgrade', (req, socket, head) => {
  const up = http.request({
    host: '127.0.0.1',
    port: devPort,
    method: req.method,
    path: req.url,
    headers: rewrite(req.headers),
  })
  up.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`)
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`,
    )
    if (upHead.length) socket.unshift(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
  })
  up.on('error', () => socket.destroy())
  if (head.length) up.write(head)
  up.end()
})

proxy.listen(proxyPort, () => {
  console.log(`\n  ${NAME}  ${url}`)
  console.log(`  (also 127.0.0.1:${devPort} - same server, no branch name)\n`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    next.kill(sig)
    proxy.close()
    process.exit(0)
  })
}
next.on('exit', (code) => {
  proxy.close()
  process.exit(code ?? 0)
})
