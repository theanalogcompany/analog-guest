import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/db/server'

// Magic-link callback. Supabase redirects back here with `?code=<otp>`
// after the user clicks the email link. We exchange it for a session
// (which sets the cookie via the server client's cookies adapter), then
// redirect into the admin shell.
//
// Failure modes:
//   - missing/empty code  → bounce to /admin/sign-in (we have nothing to
//                           exchange; the user clicked an invalid link or
//                           hit this URL directly).
//   - exchange error      → bounce to /admin/sign-in?error=invalid_link.
//                           The form's idle state shows; if we want a
//                           specific error banner later, we'll read the
//                           query param and render it. Not in scope here.

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const adminBase = request.nextUrl.origin

  if (!code) {
    return NextResponse.redirect(`${adminBase}/admin/sign-in`)
  }

  const supabase = await createServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(
      `${adminBase}/admin/sign-in?error=invalid_link`,
    )
  }

  return NextResponse.redirect(`${adminBase}/admin`)
}
