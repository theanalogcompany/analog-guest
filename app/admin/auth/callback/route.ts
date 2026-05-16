import { type NextRequest, NextResponse } from 'next/server'
import { linkOperatorByAuthUser } from '@/lib/auth/link-operator'
import { createServerClient } from '@/lib/db/server'

// Magic-link callback. Supabase redirects back here with `?code=<otp>`
// after the user clicks the email link. We exchange it for a session
// (which sets the cookie via the server client's cookies adapter), then
// eagerly link the auth user to the matching operators row (TAC-272), then
// redirect into the admin shell.
//
// Failure modes:
//   - missing/empty code   → bounce to /admin/sign-in (we have nothing to
//                            exchange; the user clicked an invalid link or
//                            hit this URL directly).
//   - exchange error       → bounce to /admin/sign-in?error=invalid_link.
//   - no_matching_operator → bounce to /admin/sign-in?error=no_access. The
//                            user authenticated, but no operators row matches
//                            their email/phone. Ticket TAC-272 §"Out of scope"
//                            keeps orphan handling minimal — bare redirect now,
//                            UX polish is a post-pilot follow-up.
//   - other link failure   → bounce to /admin/sign-in?error=link_failed. Covers
//                            multiple_matching_operators and
//                            already_claimed_by_different_user (rare data-state
//                            errors that need operator intervention to resolve).
//
// The sign-in form's error-banner rendering is "not in scope" per the form
// component itself; we just set the query param consistently.

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const adminBase = request.nextUrl.origin

  if (!code) {
    return NextResponse.redirect(`${adminBase}/admin/sign-in`)
  }

  const supabase = await createServerClient()
  const { data: exchanged, error } =
    await supabase.auth.exchangeCodeForSession(code)
  if (error || !exchanged?.user) {
    return NextResponse.redirect(
      `${adminBase}/admin/sign-in?error=invalid_link`,
    )
  }

  const linked = await linkOperatorByAuthUser(exchanged.user.id)
  if (!linked.ok) {
    if (linked.error === 'no_matching_operator') {
      return NextResponse.redirect(
        `${adminBase}/admin/sign-in?error=no_access`,
      )
    }
    return NextResponse.redirect(
      `${adminBase}/admin/sign-in?error=link_failed`,
    )
  }

  return NextResponse.redirect(`${adminBase}/admin`)
}
