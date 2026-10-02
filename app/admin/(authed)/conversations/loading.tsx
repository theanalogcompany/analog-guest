// Shown on first entry to /admin/conversations. Filter changes within the page
// do NOT show this: they are transitions that keep the old UI until the new
// render lands, and signal progress through <PendingNotice /> instead.
export default function ConversationsLoading() {
  return (
    <div
      role="status"
      className="flex min-h-[calc(100dvh-3.5rem)] -mx-8 -my-10 items-center justify-center bg-paper text-sm text-ink-soft"
    >
      Loading conversations…
    </div>
  )
}
