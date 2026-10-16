// TAC-516: no URL built in lib/messaging/instagram/oauth-exchange.ts leaves it.
//
// Pure: no network, no database, no credentials. Every call in the module runs
// against an injected fetch that plays each outcome Meta or the network can
// produce, and every one of them is checked for a leak.
//
// WHY IT EXISTS. The long-lived exchange and the token refresh put the access
// token in the query string, because graph.instagram.com refused header auth
// on both in production (2026-10-16). That is only safe while no URL is ever
// logged, returned, or put in an error. Nothing else enforces that, and the
// easy regression is a well-meant `console.error(url)` or `e.message` on a
// failure path nobody exercises.
//
// WHAT COUNTS AS A LEAK. The token, the app secret, the authorization code,
// `access_token=`, `client_secret=`, or a Meta host, anywhere in:
//   - the returned result, serialized both as JSON and with util.inspect
//     (which shows what a console.log of it would print);
//   - any argument to any console method while the call runs.
// The new token Meta hands back on success is NOT a leak: returning it is the
// call's job, and it is a different sentinel from the ones checked.
//
// THE THROWS ARE THE POINT. Node's fetch writes the full URL into the message
// of a TypeError ("Failed to parse URL from ...") and into `cause.input`. The
// hostile cases also put it into the error's name and `cause.code`, the two
// fields a network failure does carry, to show those are held to identifier
// shape rather than passed on.
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'

import type { FetchLike, GraphResult } from '@/lib/messaging/instagram/graph'
import {
  exchangeForLongLivedToken,
  exchangeInstagramCode,
  fetchConnectedAccount,
  refreshInstagramLongLivedToken,
  subscribeInstagramWebhooks,
} from '@/lib/messaging/instagram/oauth-exchange'

type Check = [name: string, ok: boolean, detail: string]

const SHORT_TOKEN = 'SENTINELshortlivedTOKEN7f3a'
const LONG_TOKEN = 'SENTINELlonglivedTOKEN44d0'
const APP_SECRET = 'SENTINELappSECRET91c2'
const AUTH_CODE = 'SENTINELauthCODE5e1b'
const NEW_TOKEN = 'freshTokenFromMeta'
const NOW = new Date('2026-10-16T02:00:00Z')

const FORBIDDEN = [
  SHORT_TOKEN,
  LONG_TOKEN,
  APP_SECRET,
  AUTH_CODE,
  'access_token=',
  'client_secret=',
  'graph.instagram.com',
  'api.instagram.com',
]

/** What each scenario's fetch does with the URL it was handed. */
type Scenario = {
  name: string
  respond: (url: string) => Response | Promise<Response>
  /** The ones that tamper with the error's name and cause code. */
  hostile?: boolean
}

/** A Response whose `url` is the request URL, as a real one's would be. */
function responseFor(url: string, body: string, status: number): Response {
  const response = new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

const SCENARIOS: Scenario[] = [
  {
    name: 'success',
    respond: (url) =>
      responseFor(
        url,
        JSON.stringify({
          access_token: NEW_TOKEN,
          expires_in: 5_184_000,
          user_id: 17841400000000000,
          username: 'venue',
          success: true,
        }),
        200,
      ),
  },
  {
    name: 'a body that is not JSON and echoes the URL',
    respond: (url) => responseFor(url, `<html>${url}</html>`, 502),
  },
  {
    name: "Meta's error, its message quoting the URL",
    respond: (url) =>
      responseFor(
        url,
        JSON.stringify({
          error: {
            message: `Invalid request ${url}`,
            type: 'IGApiException',
            code: 100,
            fbtrace_id: 'Am3ogLhjud8Bdg1cHm2TvJu',
          },
        }),
        400,
      ),
  },
  {
    name: 'a 200 with nothing usable and the URL in it',
    respond: (url) => responseFor(url, JSON.stringify({ debug: url }), 200),
  },
  {
    name: 'a URL fetch could not parse (Node puts it in message and cause.input)',
    respond: (url) => {
      const cause = Object.assign(new TypeError(`Invalid URL ${url}`), {
        code: 'ERR_INVALID_URL',
        input: url,
      })
      throw new TypeError(`Failed to parse URL from ${url}`, { cause })
    },
  },
  {
    name: 'a connection reset with the URL in every message',
    respond: (url) => {
      const cause = Object.assign(new Error(`read ECONNRESET ${url}`), {
        code: 'ECONNRESET',
      })
      throw new TypeError(`fetch failed ${url}`, { cause })
    },
  },
  {
    name: 'a timeout whose message is the URL',
    respond: (url) => {
      throw new DOMException(url, 'TimeoutError')
    },
  },
  {
    name: 'an abort whose message is the URL',
    respond: (url) => {
      throw new DOMException(url, 'AbortError')
    },
  },
  {
    name: "a throw with the URL in the error's name and cause code",
    hostile: true,
    respond: (url) => {
      const error = new Error(url, { cause: { code: url, input: url } })
      error.name = url
      throw error
    },
  },
]

/** The calls in the module, each with what it was handed. */
type Call = {
  name: string
  run: (fetchImpl: FetchLike) => Promise<GraphResult<unknown>>
  /**
   * Whether the module itself catches the network throw. The two calls that
   * go through graph.ts inherit graph.ts's own failure shaping, which this
   * ticket does not change; their hostile case is reported, not failed.
   */
  ownsNetworkPath: boolean
}

const CALLS: Call[] = [
  {
    name: 'long-lived exchange',
    run: (f) =>
      exchangeForLongLivedToken(
        { shortLivedToken: SHORT_TOKEN, appSecret: APP_SECRET, now: NOW },
        f,
      ),
    ownsNetworkPath: true,
  },
  {
    name: 'token refresh',
    run: (f) => refreshInstagramLongLivedToken(LONG_TOKEN, f, NOW),
    ownsNetworkPath: true,
  },
  {
    name: 'code exchange',
    run: (f) =>
      exchangeInstagramCode(
        {
          code: AUTH_CODE,
          redirectUri: 'https://webhooks.example/callback',
          appId: 'app',
          appSecret: APP_SECRET,
        },
        f,
      ),
    ownsNetworkPath: true,
  },
  {
    name: 'connected account',
    run: (f) => fetchConnectedAccount(LONG_TOKEN, f),
    ownsNetworkPath: false,
  },
  {
    name: 'webhook subscription',
    run: (f) =>
      subscribeInstagramWebhooks(
        { accountId: '17841400000000000', token: LONG_TOKEN },
        f,
      ),
    ownsNetworkPath: false,
  },
]

const CONSOLE_METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir',
] as const

/** Runs `fn` with every console method recording instead of printing. */
async function capturingConsole<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; printed: string }> {
  const saved = CONSOLE_METHODS.map((m) => console[m])
  const printed: string[] = []
  for (const m of CONSOLE_METHODS)
    console[m] = (...args: unknown[]) => {
      printed.push(args.map((a) => inspect(a, { depth: null })).join(' '))
    }
  try {
    return { value: await fn(), printed: printed.join('\n') }
  } finally {
    CONSOLE_METHODS.forEach((m, i) => (console[m] = saved[i]))
  }
}

function leaksIn(text: string): string[] {
  return FORBIDDEN.filter((f) => text.includes(f))
}

async function leakChecks(): Promise<Check[]> {
  const checks: Check[] = []
  for (const call of CALLS) {
    for (const scenario of SCENARIOS) {
      if (scenario.hostile && !call.ownsNetworkPath) continue
      const fetchImpl: FetchLike = async (url) => scenario.respond(url)
      let threw: unknown = null
      let value: GraphResult<unknown> | null = null
      let printed = ''
      try {
        const out = await capturingConsole(() => call.run(fetchImpl))
        value = out.value
        printed = out.printed
      } catch (e) {
        threw = e
      }
      const returned = value
        ? `${JSON.stringify(value)}\n${inspect(value, { depth: null })}`
        : ''
      const found = [...leaksIn(returned), ...leaksIn(printed)]
      checks.push([
        `${call.name}, ${scenario.name}: returns, never throws, leaks nothing`,
        threw === null && found.length === 0,
        threw !== null
          ? `threw ${inspect(threw)}`
          : `found ${found.join(', ')} in ${leaksIn(returned).length ? 'the result' : 'console output'}`,
      ])
    }
  }
  return checks
}

/** The two calls this ticket changed: what Meta is actually sent. */
async function shapeChecks(): Promise<Check[]> {
  const sent: { url: string; init: RequestInit }[] = []
  const recording: FetchLike = async (url, init) => {
    sent.push({ url, init })
    return responseFor(
      url,
      JSON.stringify({ access_token: NEW_TOKEN, expires_in: 5_184_000 }),
      200,
    )
  }
  const exchanged = await exchangeForLongLivedToken(
    { shortLivedToken: SHORT_TOKEN, appSecret: APP_SECRET, now: NOW },
    recording,
  )
  const refreshed = await refreshInstagramLongLivedToken(
    LONG_TOKEN,
    recording,
    NOW,
  )
  const [ex, re] = sent
  const exUrl = new URL(ex.url)
  const reUrl = new URL(re.url)
  const noAuthHeader = (init: RequestInit) =>
    !new Headers(init.headers).has('authorization')
  const sixtyDays = new Date(NOW.getTime() + 5_184_000 * 1000).toISOString()

  return [
    [
      'exchange: GET graph.instagram.com/access_token, unversioned',
      ex.init.method === 'GET' &&
        exUrl.origin === 'https://graph.instagram.com' &&
        exUrl.pathname === '/access_token',
      `${ex.init.method} ${exUrl.origin}${exUrl.pathname}`,
    ],
    [
      'exchange: grant_type, client_secret and access_token in the query',
      exUrl.searchParams.get('grant_type') === 'ig_exchange_token' &&
        exUrl.searchParams.get('client_secret') === APP_SECRET &&
        exUrl.searchParams.get('access_token') === SHORT_TOKEN,
      [...exUrl.searchParams.keys()].join(','),
    ],
    [
      'exchange: no Authorization header',
      noAuthHeader(ex.init),
      inspect(ex.init.headers),
    ],
    [
      'refresh: GET graph.instagram.com/refresh_access_token, unversioned',
      re.init.method === 'GET' &&
        reUrl.origin === 'https://graph.instagram.com' &&
        reUrl.pathname === '/refresh_access_token',
      `${re.init.method} ${reUrl.origin}${reUrl.pathname}`,
    ],
    [
      'refresh: grant_type and access_token in the query, no client_secret',
      reUrl.searchParams.get('grant_type') === 'ig_refresh_token' &&
        reUrl.searchParams.get('access_token') === LONG_TOKEN &&
        !reUrl.searchParams.has('client_secret'),
      [...reUrl.searchParams.keys()].join(','),
    ],
    [
      'refresh: no Authorization header',
      noAuthHeader(re.init),
      inspect(re.init.headers),
    ],
    [
      "both: success returns Meta's new token and an expiry 60 days out",
      exchanged.ok &&
        refreshed.ok &&
        exchanged.value.token === NEW_TOKEN &&
        refreshed.value.token === NEW_TOKEN &&
        exchanged.value.expiresAt.toISOString() === sixtyDays &&
        refreshed.value.expiresAt.toISOString() === sixtyDays,
      inspect({ exchanged, refreshed }),
    ],
  ]
}

/** Failures still say what failed, so the redaction is not hiding everything. */
async function failureDetailChecks(): Promise<Check[]> {
  const metaRefusal = await exchangeForLongLivedToken(
    { shortLivedToken: SHORT_TOKEN, appSecret: APP_SECRET, now: NOW },
    async (url) => SCENARIOS[2].respond(url),
  )
  const reset = await refreshInstagramLongLivedToken(
    LONG_TOKEN,
    async (url) => SCENARIOS[5].respond(url),
    NOW,
  )
  const hostile = await refreshInstagramLongLivedToken(
    LONG_TOKEN,
    async (url) => SCENARIOS[8].respond(url),
    NOW,
  )
  return [
    [
      "a Meta refusal keeps code, type and fbtrace_id (the production failure's own shape)",
      !metaRefusal.ok &&
        metaRefusal.failure.reason === 'graph_error' &&
        metaRefusal.failure.httpStatus === 400 &&
        metaRefusal.failure.code === 100 &&
        metaRefusal.failure.type === 'IGApiException' &&
        metaRefusal.failure.fbtraceId === 'Am3ogLhjud8Bdg1cHm2TvJu',
      inspect(metaRefusal),
    ],
    [
      'a connection reset keeps its error name and cause code',
      !reset.ok &&
        reset.failure.reason === 'network' &&
        reset.failure.errorName === 'TypeError' &&
        reset.failure.causeCode === 'ECONNRESET',
      inspect(reset),
    ],
    [
      "a name or cause code that is not identifier-shaped becomes 'unknown'",
      !hostile.ok &&
        hostile.failure.reason === 'network' &&
        hostile.failure.errorName === 'unknown' &&
        hostile.failure.causeCode === 'unknown',
      inspect(hostile),
    ],
  ]
}

/**
 * The source itself: nothing in the module prints, throws, or reads a
 * response's URL, and exactly one expression builds a token-bearing URL.
 * Comments are stripped first, since the header discusses all of these.
 */
function sourceChecks(): Check[] {
  const raw = readFileSync('lib/messaging/instagram/oauth-exchange.ts', 'utf8')
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const rootUrlBuilds = code.match(/\$\{INSTAGRAM_GRAPH_ROOT_URL\}/g) ?? []
  return [
    [
      'the module never calls console',
      !/\bconsole\s*\./.test(code),
      'console.* found',
    ],
    ['the module never throws', !/\bthrow\b/.test(code), 'throw found'],
    [
      "the module never reads a response's url",
      !/\.url\b/.test(code),
      '.url found',
    ],
    [
      'exactly one place builds a URL at the Graph root',
      rootUrlBuilds.length === 1,
      `${rootUrlBuilds.length} found`,
    ],
  ]
}

async function main(): Promise<void> {
  const all = [
    ...(await shapeChecks()),
    ...(await failureDetailChecks()),
    ...(await leakChecks()),
    ...sourceChecks(),
  ]
  let failed = 0
  for (const [name, ok, detail] of all) {
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`)
  }
  console.log(`\n${all.length - failed}/${all.length}`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
