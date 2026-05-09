// Wraps every /admin/* route (both the (authed) group and the sign-in /
// OAuth-callback siblings) in a data-attribute scope. Per-surface palette
// overrides for the admin shell live in app/globals.css under the
// [data-surface="admin"] selector — keeping :root tokens canonical brand
// while admin renders on white.

export default function AdminSurfaceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div data-surface="admin" className="min-h-screen bg-paper">
      {children}
    </div>
  )
}
