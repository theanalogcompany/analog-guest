# app/admin - the Command Center

Loads only when you work in this directory. Analog-staff debugging surface, served on
`admin.theanalog.company`. **Direct** register per the style guide.

## Two things that will waste an afternoon

**Admin API routes live at `/admin/{surface}/api/{thing}`, never `/api/admin/...`.** The
host gate in root `middleware.ts` 404s anything not starting with `/admin` on the admin
apex. A route at `/api/admin/...` works locally and on `*.vercel.app` previews (both bypass
the gate for QA) and **404s in production**. Signature: works locally, deploys clean, prod
returns 404 with the correct request URL.

**The auth gate is cookie-session, not bearer.** `app/admin/(authed)/layout.tsx` reads the
session and calls `verifyAnalogAdminAccess(session.user.id)`. Sign-in and the OAuth callback
are siblings **outside** the route group so they bypass the gate without a redirect loop.

Three states at the gate: no session redirects to sign-in; session without admin renders
`<NotAuthorized>` **in place** (do not redirect - the user has identity, just not
authorization); admin renders the shell.

Granting access is a hand-written Studio `UPDATE` on `operators.is_analog_admin`. Nothing
automates it.

For local testing only, `ADMIN_AUTH_DISABLED=1` bypasses the whole gate -
`lib/auth/dev-bypass.ts` holds the guards (dev build + localhost host + refusal on any
Vercel marker). Set it per shell; it must never be written into `.env.local`.

## Loaders

One loader per surface under `_lib/`, `cache()`-wrapped, allowlist-scoped. Conventions:

- **An empty `allowedVenueIds` means analog-admin scope here** - see everything. That is the
  opposite of the bearer path's meaning; `lib/operator/CLAUDE.md` has the full trap.
- **Degrade, do not 500.** A missing venue returns `null` into `notFound()`. A malformed
  JSONB returns a fallback plus a parse-error string rendered as a banner.
- **A degraded read must carry a flag the page renders.** An unlabelled empty list reads as
  "nothing here", which is a false absolute claim - one loader would have rendered "this
  venue owes no guest anything" off a query that never ran.
- **Fetch `LIMIT + 1` and report `hasMore`.** Comparing `rows.length` to the cap cannot tell
  exactly-N from more-than-N, and the page states the cap as fact.
- **State the cap on the page.** A silent truncation reads as complete coverage. The
  conversations viewer shipped ASC `LIMIT 200`, which kept the **oldest** 200 rows and hid
  everything newer the night a venue crossed the cap. Window newest-first and reverse in JS.

Do not copy the agent runtime's narrower SELECTs into an admin loader. The runtime omits
columns it never reads, which are exactly the ones an investigation surface needs.

## Render from the data, not from a hand-built list of sections

The venue page declares an allowlist of claimed keys and renders anything unclaimed in a
visible catch-all, suppressing empty values. That is how two live fields were found. Type
the allowlist `satisfies ReadonlyArray<keyof Row>` so a rename fails `tsc`.

A near-miss worth knowing: the mechanics allowlist was snake_case while the call site passed
a camelCase row through a cast, so every mapped field read as unclaimed and the catch-all
became noise on every mechanic.

## Write routes

Read-modify-write and **validate the whole object**, mirroring the persona route. For
`venue_info` this is load-bearing in a way it is not for other columns: it renders into every
prompt turn, so a partial write that drops a sibling key is the agent losing a fact with no
error anywhere.

**The admin write boundary is stricter than the live read boundary.** Routes reject unknown
keys and unknown enum values where the runtime parser degrades gracefully. Both are correct:
strict offline, permissive live.

Write **only** the fields the admin touched, layered on what is stored. Writing every shown
field turns a fleet-wide code default into an explicit stored entry, which silently strips
the carve-out attached to the default and breaks the mechanism for adding future defaults.

Soft-delete anything an `engagement_events` row references. A real DELETE orphans redemption
history.

## Ordering around a slow call

Insert and embed **first**, delete the source **last**, and **re-read fresh** before the
final write. An embed is a slow network round trip, so writing back a snapshot taken before
it clobbers any edit made during the window. Filtering an already-removed entry out of a
fresh read is a safe no-op.

If the final write fails after the embed succeeded, the new row is already live: return the
error and log loudly, but do not delete what succeeded.

## Copied strings

A copied string literal renders identically to a read one until the constant changes. Two rules:

- **No prompt-line literal may be pasted into a component.** Compare normalized: `react/no-unescaped-entities`
  turns a bare apostrophe into `&apos;`, and prettier may wrap a paste across a newline, so a
  copy can hide behind either.
- **No reuse of `formatTimeDelta`** from `lib/ai/prompts/serializers.ts`. That is the agent's
  prompt vocabulary; importing it couples a prompt rewrite to this page's appearance. There
  is a local `formatAge` instead - this reads like duplication and the next person's instinct
  is to de-duplicate it.

## Brand

Tokens live in `app/globals.css` under `@theme inline` (Tailwind v4, no config file).

**Scope a surface override with `[data-surface="..."]`, never by mutating `:root`.** Admin
renders on white rather than the canonical cream by re-binding the tokens under
`[data-surface="admin"]`, which lets every component keep its existing classes.

shadcn tokens are aliased **onto the brand vars**, not onto literals - a literal freezes the
token to cream and breaks the admin override. Every shadcn token must be bridged, none dangling.

`components/ui/*` is vendored shadcn source: treat as third-party, exempt from the no-`any`
and errors-as-values conventions, and prefer re-running the CLI over hand-edits.

No emoji, no checkmarks. Status uses `<StatusDot>`, where `bad` means actually wrong, not
"this guest is new".

Put new section chrome in `app/admin/_components/section-shell.tsx`. A local
re-declaration is how the last one drifted on padding.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
