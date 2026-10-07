// TAC-516: the three pages the Instagram callback can render.
//
// Split from the route so there is exactly one place that builds HTML — a second
// one is how a token eventually reaches a page.
//
// ONE VALUE HERE IS ATTACKER-CONTROLLED, AND IT IS ESCAPED: the `code` on the
// code page. Anyone can open this URL with `?code=<anything>`, so it goes
// through `escapeHtml`, it is capped at INSTAGRAM_CALLBACK_CODE_MAX_LENGTH,
// and it is written into the markup in exactly one place — the textarea. The
// script reads it back from the element, so it is never interpolated into
// JavaScript.
//
// Everything else is fixed or allowlisted, and stays unescaped on purpose. The
// failure page takes a fixed reason from a closed union, never Meta's error
// message, never the state, never a token, never an account id. The success
// page renders the handle only when it matches Instagram's own character set.

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

const FAILURE_COPY: Record<
  InstagramCallbackFailure,
  { title: string; detail: string }
> = {
  missing_parameters: {
    title: 'That link was incomplete',
    detail:
      'Instagram did not send everything we needed. Start the connection again from the app.',
  },
  state_invalid: {
    title: 'We could not verify that link',
    detail:
      'It did not come from us, or it was altered on the way. Start the connection again from the app.',
  },
  state_expired: {
    title: 'That link expired',
    detail:
      'Connection links are good for a few minutes. Start the connection again from the app.',
  },
  state_already_used: {
    title: 'That link was already used',
    detail:
      'Each connection link works once. Start the connection again from the app.',
  },
  account_already_connected: {
    title: 'That Instagram account is already connected',
    detail:
      'It belongs to another venue. Disconnect it there first, or connect a different account. Nothing here was changed.',
  },
  exchange_failed: {
    title: 'Instagram did not complete the connection',
    detail:
      'Nothing was changed. Try again from the app, and if it keeps happening let us know.',
  },
  not_configured: {
    title: 'This is not set up yet',
    detail:
      'Connecting Instagram is not configured on our side. Let us know and we will sort it out.',
  },
  storage_failed: {
    title: 'We could not save that connection',
    detail:
      'Nothing was changed. Try again from the app, and if it keeps happening let us know.',
  },
}

/** The longest `code` the code page will show. Longer is not a code. */
export const INSTAGRAM_CALLBACK_CODE_MAX_LENGTH = 1024

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(
  title: string,
  heading: string,
  body: string,
  extra: { head: string; main: string } = { head: '', main: '' },
): string {
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
</style>${extra.head}
</head>
<body><main><h1>${heading}</h1><p>${body}</p>${extra.main}</main></body>
</html>`
}

// 16px on the textarea is deliberate: iOS Safari zooms the page when a field
// with a smaller font takes focus, and this page is opened on a phone.
const CODE_PAGE_HEAD = `
<meta name="referrer" content="no-referrer">
<style>
  body { box-sizing: border-box; }
  main { width: 100%; }
  textarea {
    display: block; box-sizing: border-box; width: 100%; margin: 1.25rem 0 0; padding: 0.75rem;
    font: 16px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all;
    color: inherit; background: #ffffff; border: 1px solid #d6d3d1; border-radius: 10px; resize: none;
  }
  button {
    display: block; width: 100%; min-height: 48px; margin: 0.75rem 0 0; padding: 0 1rem;
    font: inherit; font-weight: 600; color: #fafaf9; background: #1c1917;
    border: 0; border-radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    textarea { background: #292524; border-color: #44403c; }
    button { color: #1c1917; background: #fafaf9; }
  }
</style>`

// "Copied" is shown only when the clipboard write resolved. Every other
// outcome — no clipboard API, a refused permission, an insecure context —
// selects the text and says so, so the label never claims a copy that did not
// happen.
const CODE_PAGE_SCRIPT = `<script>
(function () {
  var box = document.getElementById('code');
  var button = document.getElementById('copy');
  function selectAll() {
    box.focus();
    box.select();
    box.setSelectionRange(0, box.value.length);
  }
  function selected() {
    selectAll();
    button.textContent = 'Selected, now copy';
  }
  box.addEventListener('click', selectAll);
  button.addEventListener('click', function () {
    try {
      navigator.clipboard.writeText(box.value).then(function () {
        button.textContent = 'Copied';
      }, selected);
    } catch (e) {
      selected();
    }
  });
})();
</script>`

/**
 * The page for a `code` that arrived with no `state`: a manual authorize
 * link, where a person carries the code to us by hand. Shows the code and
 * nothing else. Returns null for a code over the cap, so the cap cannot be
 * skipped by a caller.
 */
export function instagramCallbackCodePage(code: string): string | null {
  if (code.length > INSTAGRAM_CALLBACK_CODE_MAX_LENGTH) return null
  return page(
    'Almost done',
    'Almost done',
    'Tap Copy, then text the code to Jaipal.',
    {
      head: CODE_PAGE_HEAD,
      main: `<textarea id="code" readonly rows="4" aria-label="Your code" spellcheck="false" autocapitalize="off" autocomplete="off">${escapeHtml(code)}</textarea><button id="copy" type="button">Copy</button>${CODE_PAGE_SCRIPT}`,
    },
  )
}

export function instagramCallbackSuccessPage(username: string | null): string {
  // The handle is the one value here that comes from Meta. It is rendered
  // only when it matches Instagram's own character set, so nothing arbitrary
  // reaches the markup even though Meta is not an attacker.
  const safeHandle =
    username !== null && /^[A-Za-z0-9._]{1,30}$/.test(username)
      ? username
      : null
  const body = safeHandle
    ? `You are connected as @${safeHandle}. You can close this and go back to the app.`
    : 'You are connected. You can close this and go back to the app.'
  return page('Instagram connected', 'Instagram connected', body)
}

export function instagramCallbackFailurePage(
  reason: InstagramCallbackFailure,
): string {
  const copy = FAILURE_COPY[reason]
  return page('Instagram not connected', copy.title, copy.detail)
}

export const INSTAGRAM_CALLBACK_FAILURE_STATUS: Record<
  InstagramCallbackFailure,
  number
> = {
  missing_parameters: 400,
  state_invalid: 401,
  state_expired: 401,
  state_already_used: 401,
  account_already_connected: 409,
  exchange_failed: 502,
  not_configured: 500,
  storage_failed: 500,
}
