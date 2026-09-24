// GET /api/instagram/data-deletion/status?id=<confirmation_code> — TAC-516.
//
// The page the deletion callback's response points at. Meta's tester opens
// it, and so can the person who asked.
//
// PUBLIC AND UNAUTHENTICATED, because the confirmation code is the only thing
// the requester has. That is why the page says only whether a request with
// that code was completed, and NOTHING about the venue, the account, the
// guests or how many were affected: a code is a bearer value, and anything
// beyond a yes or no would be readable by anyone who saw it once.
//
// An unknown code is answered the same way as a pending one rather than with
// a 404, so the endpoint cannot be used to test which codes exist.

import { createAdminClient } from '@/lib/db/admin'

export const dynamic = 'force-dynamic'

function page(heading: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data deletion request</title>
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
</html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

export async function GET(request: Request): Promise<Response> {
  const code = new URL(request.url).searchParams.get('id')
  // A confirmation code is 32 hex characters. Anything else cannot match a
  // row, and refusing it here keeps arbitrary input out of the query.
  if (!code || !/^[0-9a-f]{32}$/.test(code)) {
    return page('Data deletion request', 'We have no record of that request.', 404)
  }

  const { data, error } = await createAdminClient()
    .from('instagram_deletion_requests')
    .select('completed_at')
    .eq('confirmation_code', code)
    .maybeSingle()

  if (error) {
    console.error('[instagram data-deletion status] lookup failed', {
      event: 'instagram_data_deletion_status_failed',
      error: error.message,
    })
    return page(
      'Data deletion request',
      'We could not check that request just now. Try again shortly.',
      500,
    )
  }

  // An unknown code and a pending one read the same, so this cannot be used
  // to discover which codes are real.
  if (!data || (data as { completed_at: string | null }).completed_at === null) {
    return page(
      'Data deletion request',
      'We have no completed record for that request. If you have just made it, it may still be in progress.',
      200,
    )
  }

  return page(
    'Data deleted',
    'The Instagram data associated with that request has been removed.',
    200,
  )
}
