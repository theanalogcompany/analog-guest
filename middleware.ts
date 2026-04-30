import { type NextRequest, NextResponse } from 'next/server'

// Host gating for the colocated admin scaffold (THE-198).
//
// Two Vercel projects deploy this same repo:
//   - analog-guest  → guest host (e.g. webhooks.theanalog.company, the
//                     marketing root, etc.). Should NOT serve /admin/*.
//   - analog-admin  → admin.theanalog.company. Should ONLY serve /admin/*.
//
// In production we 404 cross-host paths. Local dev (localhost / 127.0.0.1)
// and Vercel previews (*.vercel.app) serve everything so QA can validate
// either surface from a single host.

export function middleware(request: NextRequest) {
  const host = request.headers.get('host') ?? ''
  const path = request.nextUrl.pathname

  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return NextResponse.next()
  }
  if (host.endsWith('.vercel.app')) {
    return NextResponse.next()
  }

  const isAdminHost = host === 'admin.theanalog.company'
  const isAdminPath = path.startsWith('/admin')

  if (isAdminHost && !isAdminPath) {
    return new NextResponse(null, { status: 404 })
  }
  if (!isAdminHost && isAdminPath) {
    return new NextResponse(null, { status: 404 })
  }

  return NextResponse.next()
}

export const config = {
  // Run on everything except Next.js internals + favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
