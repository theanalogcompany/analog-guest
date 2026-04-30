import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/db/server'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { SignInForm } from './sign-in-form'

// Sign-in landing. Public — bypasses the (authed) layout's gate by living
// outside that route group. Direct register: name the surface, hand them
// the form. No "Welcome back" copy, no marketing.
//
// Already-signed-in operators get redirected straight to /admin so they
// don't have to click through the form again. The (authed) layout will
// then either show the admin shell or NotAuthorized depending on flag.

export default async function SignInPage() {
  const supabase = await createServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (session) {
    redirect('/admin')
  }

  return (
    <div className="min-h-screen bg-paper text-ink flex items-center justify-center p-8">
      <div className="max-w-sm w-full flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Eyebrow>Command Center</Eyebrow>
          <SectionHeader
            title="Sign in"
            subtitle="Magic link to your operator email."
          />
        </div>
        <SignInForm />
      </div>
    </div>
  )
}
