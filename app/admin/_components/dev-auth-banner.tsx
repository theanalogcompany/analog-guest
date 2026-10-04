// Rendered by the (authed) layout ONLY while the local-dev auth bypass
// (lib/auth/dev-bypass.ts) is active. Deliberately ugly and un-themed: this
// must never read as part of the product.

export function DevAuthBanner() {
  return (
    <div className="mb-6 rounded-md border-2 border-red-600 bg-red-50 px-4 py-2 text-sm font-bold tracking-wide text-red-700">
      AUTH DISABLED - LOCAL DEV. Every request is a fleet-wide analog admin
      (ADMIN_AUTH_DISABLED=1). Unset the variable and restart to restore the
      gate.
    </div>
  )
}
