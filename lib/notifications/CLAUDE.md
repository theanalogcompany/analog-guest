# lib/notifications - APNs push

Loads only when you work in this directory.

Three surfaces, one transport: draft-flagged (`send.ts`), commitment arrival
(`send-commitment-push.ts`), Instagram window warning (`send-instagram-window-push.ts`).
Shared recipient loading and token invalidation in `recipients.ts`.

**Nothing here ever throws.** Every surface is fire-and-forget via `waitUntil`.

## Env vars fail SILENTLY, so the validation is three-part

Unlike a missing DB credential, a missing `APNS_*` var produces no 500: the agent path
continues and push just does not arrive. So:

1. `env.ts` is a **pure shape validator** - takes the env object, returns
   `{ok} | {ok: false, problems}`, never throws, and **never returns key material** (it
   reports "missing END footer", not the value). Layer-scoped via `JWT_APNS_VARS` /
   `TRANSPORT_APNS_VARS` so the transport is not coupled to signing credentials.
2. **First-call enforcement** at each layer boundary, not at module load - CI sets no
   `APNS_*` vars at all, so a module-init throw breaks `tsc` and `next build`.
3. **Ambient visibility** via `/admin/health`, because a validator that only runs on the
   unhappy path of a fire-and-forget call is not loud enough alone.

Mirror this three-part shape for any future credential env var.

`APNS_AUTH_KEY` is the PEM **contents**, multi-line, including both armor lines. A paste
missing the `-----END PRIVATE KEY-----` footer signs nothing and failed silently for nine
hours after deploy.

`APNS_ENV` selects the host: a TestFlight or App Store build needs `production`, an Xcode
dev build needs `sandbox`. A mismatch returns 400 `BadDeviceToken` and delivers nothing.

**Set every var on Preview as well as Production.**

## PUSH_POLICY is a DENY-LIST and must stay one

`push-policy.ts` is `satisfies Record<ApprovalTrigger, PushDecision>` - **total**, so a new
trigger fails `tsc` until someone decides. Everything pushes except an explicit skip.

It was an allow-list derived from `Object.keys()` of a label map that did two jobs. Two
triggers shipped afterwards, fell outside it, and **no APNs request was attempted for two
months**.

So: `shouldSendDraftFlaggedPush` additionally **fails OPEN** on an unrecognised string. A
dismissible push beats a queued draft nobody was told about.

The context-label map is deliberately a **separate** `Partial` map. Do not merge them back
into one constant - that merge is what caused the outage.

`REASON_BY_REVIEW_REASON` is total over every value that can reach a push. It was partial
and twelve reasons pushed as a bare `Reply to Alex`.

`instagram_send_failed` is a **literal** there, not an import, because importing it would
pull Instagram's outbound modules onto the shared push path against the import guard. Keep
the two copies equal.

## Privacy

The payload carries `{aps: {alert: {title, body}, badge, sound}, draftId, guestId,
operatorId}`. Per-surface rules:

- **Draft push** quotes the guest's question in the body, **suppressed** for
  `comp_complaint`, an unresolved category, **and a crisis turn**. `crisisSafety` is a
  separate boolean from `category`, so a category-only gate quotes a self-harm message onto
  every operator's lock screen - and that path is reachable, not hypothetical. Key on
  `ctx.classification.category`, **never on the trigger**: a complaint routes to a
  comp-forward draft, so its commonest `primaryTrigger` is `commitment_type_gated`.
- **Arrival push** carries the commitment description, which is our own text about our own
  promise, and the guest's message has no route into that function.
- **Window warning** is content-free: no body, no handle.

## Badge counts genuinely disagree

`countPendingDraftsForOperator` counts pending drafts. `countOperatorBadge` counts drafts
**plus** pending_ack commitments. `send.ts` uses the first and the arrival surface the
second, so the same operator's badge is one number when a draft queues and another when a
commitment arrives.

Both are kept with their existing callers, in one file where the disagreement can be read.
Making them agree changes what an operator sees and is a product decision.

**A new surface should use `countOperatorBadge`** - a badge that ignores commitments
under-reports what is waiting.

## Other

- 410 Gone and 400 BadDeviceToken null both token columns.
- Every response logs one unconditional line including success, so a UAT run can tell "APNs
  accepted it" from "we never got there" without waiting on PostHog.
- A push surface trusts its caller's CAS win and does not re-check row state. Calling one
  from anywhere other than a CAS-win path double-pushes.
- Minutes round **down** in the window warning, so the number never promises more time than
  there is.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
