// TAC-516: the two pages the Instagram callback can render.
//
// Split from the route so the copy is testable without exercising the whole
// OAuth flow, and so there is exactly one place that builds HTML — a second
// one is how a token eventually reaches a page.
//
// NOTHING INTERPOLATED HERE IS ATTACKER-CONTROLLED OR SECRET. The failure
// page takes a fixed reason from a closed union, never Meta's error message,
// never the state, never a token, never an account id. That is why there is
// no escaping: there is nothing to escape, and keeping it that way is the
// invariant rather than the escaping being the defence.

/** Why a connect attempt did not finish. Fixed copy, closed set. */
export type InstagramCallbackFailure =
  | 'missing_parameters'
  | 'state_invalid'
  | 'state_expired'
  | 'state_already_used'
  | 'account_already_connected'
  | 'exchange_failed'
  | 'not_configured'
  | 'storage_failed'

const FAILURE_COPY: Record<InstagramCallbackFailure, { title: string; detail: string }> = {
  missing_parameters: {
    title: 'That link was incomplete',
    detail: 'Instagram did not send everything we needed. Start the connection again from the app.',
  },
  state_invalid: {
    title: 'We could not verify that link',
    detail: 'It did not come from us, or it was altered on the way. Start the connection again from the app.',
  },
  state_expired: {
    title: 'That link expired',
    detail: 'Connection links are good for a few minutes. Start the connection again from the app.',
  },
  state_already_used: {
    title: 'That link was already used',
    detail: 'Each connection link works once. Start the connection again from the app.',
  },
  account_already_connected: {
    title: 'That Instagram account is already connected',
    detail:
      'It belongs to another venue. Disconnect it there first, or connect a different account. Nothing here was changed.',
  },
  exchange_failed: {
    title: 'Instagram did not complete the connection',
    detail: 'Nothing was changed. Try again from the app, and if it keeps happening let us know.',
  },
  not_configured: {
    title: 'This is not set up yet',
    detail: 'Connecting Instagram is not configured on our side. Let us know and we will sort it out.',
  },
  storage_failed: {
    title: 'We could not save that connection',
    detail: 'Nothing was changed. Try again from the app, and if it keeps happening let us know.',
  },
}

function page(title: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #faf9f7; color: #1c1917; padding: 24px;
  }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.55; color: #44403c; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #fafaf9; }
    p { color: #d6d3d1; }
  }
</style>
</head>
<body><main><h1>${heading}</h1><p>${body}</p></main></body>
</html>`
}

export function instagramCallbackSuccessPage(username: string | null): string {
  // The handle is the one value here that comes from Meta. It is rendered
  // only when it matches Instagram's own character set, so nothing arbitrary
  // reaches the markup even though Meta is not an attacker.
  const safeHandle = username !== null && /^[A-Za-z0-9._]{1,30}$/.test(username) ? username : null
  const body = safeHandle
    ? `You are connected as @${safeHandle}. You can close this and go back to the app.`
    : 'You are connected. You can close this and go back to the app.'
  return page('Instagram connected', 'Instagram connected', body)
}

export function instagramCallbackFailurePage(reason: InstagramCallbackFailure): string {
  const copy = FAILURE_COPY[reason]
  return page('Instagram not connected', copy.title, copy.detail)
}

export const INSTAGRAM_CALLBACK_FAILURE_STATUS: Record<InstagramCallbackFailure, number> = {
  missing_parameters: 400,
  state_invalid: 401,
  state_expired: 401,
  state_already_used: 401,
  account_already_connected: 409,
  exchange_failed: 502,
  not_configured: 500,
  storage_failed: 500,
}
