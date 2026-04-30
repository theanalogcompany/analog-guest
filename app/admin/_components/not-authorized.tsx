import { SectionHeader } from '@/lib/ui'
import { SignOutButton } from './sign-out-button'

// Rendered from app/admin/layout.tsx when the user is signed in but not
// flagged is_analog_admin. NOT a redirect to sign-in — the user is
// authenticated, just not authorized; sending them to sign-in would
// misrepresent the state.
//
// Direct register, terse. Sign-out visible so the user can step out cleanly.

interface NotAuthorizedProps {
  email: string
}

export function NotAuthorized({ email }: NotAuthorizedProps) {
  return (
    <div className="min-h-screen bg-paper text-ink flex items-center justify-center p-8">
      <div className="max-w-md w-full flex flex-col gap-6">
        <SectionHeader
          title="Not authorized"
          subtitle={
            <>
              This account isn&apos;t set up as an Analog admin. If that&apos;s
              wrong, ask Jaipal.
            </>
          }
        />
        <div className="text-sm text-ink-soft">Signed in as {email}.</div>
        <div>
          <SignOutButton />
        </div>
      </div>
    </div>
  )
}
