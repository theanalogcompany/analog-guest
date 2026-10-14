import { GUEST_MEDIA_SITUATION, OUTREACH_SITUATION } from './detect-situations'
import { PolicySetSchema, type PolicySet } from './schema'

// The seed policy set every venue starts from. Thresholds are PLACEHOLDERS
// until the calibration set (phase 4) measures the actual noul distributions
// on known violations - move them on its evidence, not on argument (the
// JEV_CRISIS_THRESHOLD precedent in classify-message-jev.ts).
//
// The asymmetry rule from that module applies here too: a LOW threshold
// encodes "prefer to queue when ambiguous" (a false positive costs one
// operator glance; a false negative is unapproved money reaching a guest).
//
// The LEAK rows all ask the DISCREPANCY question - "...not covered by
// `declared_actions`" - never the open-ended one. A draft that declared its
// comp as an action is already queued by the structural row; the Noul exists
// to catch the leak, and a matching declared action is exonerating context.
//
// `complaint_resolution` is the one semantic row that is NOT a discrepancy
// question, because it is not guarding a commitment - the leak rows already
// do that, in every situation. It asks what the draft is DOING, so that the
// opening of a complaint can go out at conversation speed while the reply
// that decides something waits. Its header comment carries the reasoning.

const DEFAULT_POLICIES_INPUT = {
  policies: [
    // Structural: a declared action is a commitment by definition.
    {
      key: 'action_comp',
      label: 'Offers something on the house',
      detection: { kind: 'structural', action: 'offer_comp' },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    {
      key: 'action_hold',
      label: 'Promises to hold or reserve something',
      detection: { kind: 'structural', action: 'offer_hold' },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    {
      key: 'action_discount',
      label: 'Offers a discount',
      detection: { kind: 'structural', action: 'offer_discount' },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    {
      key: 'action_cancellation',
      label: 'Cancels or changes an existing commitment',
      detection: { kind: 'structural', action: 'cancel_commitment' },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    // Situation-scoped: the v2 successor of v1's category_requires_approval.
    // Any draft written while the situation is active queues for the owner,
    // whatever the draft says. A venue tunes these rows per its own comfort.
    //
    // COMPLAINT IS THE ONE EXCEPTION, and it is split across the two rows
    // below. The situation row holds nothing and only tells the owner; the
    // resolution row is what queues.
    //
    // Why: "whatever the draft says" made the OPENING of a complaint wait on
    // a human. "sorry to hear that. what happened?" is what the owner would
    // have typed, and making a guest wait on an operator before you will even
    // ask what went wrong is worse service than any draft this row protects
    // against. v1 had reached the same conclusion from the other direction -
    // canAutoSendComplaintTurn (lib/agent/complaint-routing.ts) exempted a
    // genuine clarifying question from the category hold - and v2 dropped it.
    // This is that carve-out restored in policy-row form, inverted because v2
    // rows ask "must this queue?" rather than "may this send?".
    //
    // What still holds the money is unchanged and is NOT these rows: the four
    // structural action rows above and comp_leak / promise_leak /
    // cancellation_leak below all run unscoped by situation and all fail
    // closed. The 2026-08-07 incident ("come by and I'll have another made
    // for you") is caught by those whether or not a complaint was detected.
    // What complaint_resolution adds on top is the non-commitment half: who
    // gets to accept blame, deny it, or tell a guest the drink was meant to
    // taste that way.
    {
      key: 'complaint_notifies_owner',
      label: 'Complaint in progress',
      detection: { kind: 'always' },
      conditions: { situations: ['complaint'] },
      then: 'notify',
      onCheckFailure: 'open',
    },
    // MEASURED by `npm run measure-complaint-split`, 9/9 as specified:
    // the asking arm lands 0.020 - 0.100, the deciding arm 0.770 - 0.960.
    // 0.3 sits in that gap with room on both sides, so it is a placeholder
    // only in the sense that the gap, not the number, is the evidence - move
    // it when a case lands between 0.1 and 0.77, and add that case first.
    //
    // The run also answers "does this row earn its place": the dismissal
    // ("that's actually how the cortado is meant to taste") is caught by
    // complaint_resolution ALONE - no structural row, no leak row, nothing
    // else in the set. Every other deciding draft is double-covered.
    {
      key: 'complaint_resolution',
      label: 'Answers a complaint rather than asking about it',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` respond to the substance of the complaint, rather than only acknowledging it and asking what happened?',
        criteria: {
          true: 'The text decides something: it accepts or denies fault, explains why the problem happened, states what the venue will or will not do, or tells the guest the experience was intended. A reply that both asks and decides is true.',
          false:
            'The text only acknowledges the problem and asks what happened, what they ordered, or when they came in. Sympathy carrying no claim about the problem ("sorry to hear that") is false.',
        },
        threshold: 0.3,
      },
      conditions: { situations: ['complaint'] },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    // The v2 successor of v1's `media_context` approval trigger, and the same
    // owner ruling (2026-10-11): A REPLY WRITTEN AROUND MEDIA THE AGENT CANNOT
    // SEE IS HELD, NEVER AUTO-SENT. The agent still drafts.
    //
    // It is a hold and not a prompt fix on purpose, and that was measured on
    // v1 (TAC-582, 20 generations, two venues): the model never described a
    // photo it had not seen, and in 7 of 20 replies it told the guest "we
    // can't see it on our end", which is false - the operator can. Two
    // rewordings moved which false thing it said and not whether it said one.
    // Do not try a third here either.
    //
    // `kind: 'always'` because the fact is already settled before the gate
    // runs: `guest_media` is in `situations` only when the thread's own rows
    // say the reply is written around media (lib/relationship/turn-media.ts,
    // which calls v1's `decideMediaContextHold`). There is nothing for a Noul
    // to add, and nothing to pay for.
    //
    // `onCheckFailure: 'open'` is NOT a relaxation. The row never consults the
    // semantic check at all, so that field is unreachable for it; the
    // situation-scoped rows above read the same way.
    //
    // A DESCRIBED PHOTO IS STILL HELD. Once the describe step has looked at
    // one, the prompt says what it shows - and the owner's ruling on that
    // ticket (TAC-584) was the same one: every media reply is held, at first.
    // Do not read a good held draft as licence to auto-send it.
    {
      key: 'guest_media_requires_approval',
      label: 'Reply written around media the agent cannot see',
      detection: { kind: 'always' },
      conditions: { situations: [GUEST_MEDIA_SITUATION] },
      then: 'queue',
      onCheckFailure: 'open',
    },
    {
      key: 'mechanic_request_requires_approval',
      label: 'Reply to a perk or hold request',
      detection: { kind: 'always' },
      conditions: { situations: ['mechanic_request'] },
      then: 'queue',
      onCheckFailure: 'open',
    },
    {
      key: 'private_event_inquiry_requires_approval',
      label: 'Reply to a private event or booking inquiry',
      detection: { kind: 'always' },
      conditions: { situations: ['private_event_inquiry'] },
      then: 'queue',
      onCheckFailure: 'open',
    },
    {
      key: 'needs_human_requires_approval',
      label: 'Message that needs a human first',
      detection: { kind: 'always' },
      conditions: { situations: ['needs_human'] },
      then: 'queue',
      onCheckFailure: 'open',
    },
    // Venue-initiated outreach (v2.21.0): EVERY unprompted draft queues for
    // the operator - the default posture for a surface no measurement has
    // earned auto-send for yet. The situation is structural (OUTREACH_SITUATION
    // in detect-situations.ts, injected by the turn runner on outreach turns,
    // never detected), so this row fires on exactly those turns and no others.
    // Relaxing it per venue is an owner decision for after the queue has
    // shown draft quality - and that relaxation must also decide the
    // Jev-outage direction for unprompted sends (nobody is waiting on one, so
    // holding costs nothing; decision 0003's asymmetry).
    {
      key: 'outreach_requires_approval',
      label: 'Venue-initiated outreach',
      detection: { kind: 'always' },
      conditions: { situations: [OUTREACH_SITUATION] },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    // Semantic: the prose-leak backstops.
    //
    // The standing-policy clause in comp_leak's false criteria is owner-ruled
    // (2026-10-05): "orders over $50 ship free" is the store's published
    // policy, straight from the venue's knowledge - not a per-guest giveaway.
    // Measured matching 3/3 on the bare-domain-link scenario before the
    // clause (p crossed the 0.3 placeholder threshold); that scenario now
    // forbids comp_leak so the lesson stays enforced.
    //
    // THAT CLAUSE ONLY REACHED DEAL-SHAPED POLICY, which is how "$5.50. Oat
    // milk is no extra charge." queued at 0.60. A thing the venue simply
    // always gives - free refills (0.72), free water (0.63), a bite with the
    // pour over (0.58), no corkage (0.39) - satisfied the true criterion as
    // written, because it IS a concrete free item. The two halves below are
    // each necessary and neither is sufficient: scoping the TRUE criterion to
    // this guest alone leaves refills at 0.45, and the standing-practice
    // sentence alone leaves refills 0.33, a free biscuit 0.32 and kids-eat-
    // free 0.31, all still queueing. Together every one of those lands at or
    // under 0.23 while the per-guest giveaways the row exists for sit at
    // 0.84 - 0.96, including the one that separates the two readings of the
    // same item: "we don't normally do it, but your oat milk is free this
    // time" (0.96 -> 0.91).
    {
      key: 'comp_leak',
      label: 'Free or discounted item promised in prose only',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` promise the guest something free, discounted, or "on us" that has NO corresponding entry in `declared_actions`?',
        criteria: {
          true: 'The text offers a concrete free or discounted item, drink, or treat TO THIS GUEST - something another guest asking the same question would not be told - and `declared_actions` contains no matching offer. Vague warmth ("next time\'s on me" as a clear offer) counts as true.',
          false:
            'No giveaway is promised, or every promise in the text matches an entry in `declared_actions`. Friendly language with no concrete commitment ("hope to see you soon") is false. Stating a standing store policy that applies to every customer (free shipping over a threshold, a published deal) is false - a policy is not a per-guest giveaway. Something the venue gives or includes for every customer at no charge or no upcharge - free refills, free water, a milk substitute with no upcharge - is false for the same reason: nothing has been given to THIS guest that any other guest would not get.',
        },
        threshold: 0.3,
      },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    {
      key: 'cancellation_leak',
      label: 'Claims a cancellation or change with no action behind it',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` tell the guest that something was cancelled, changed, rebooked, or undone, with NO corresponding entry in `declared_actions`?',
        threshold: 0.3,
      },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    // The standing-fact clause in promise_leak's false criteria is comp_leak's
    // standing-policy ruling (above) applied to the other leak row, and it is
    // the same defect: a quoted price satisfied the true criterion as written,
    // because a guest told "$6" does "arrive expecting the specific thing
    // stated". Measured over the clause, nothing else changed - the three
    // price/menu false positives fall 0.36/0.46/0.38 -> 0.06/0.06/0.07, and
    // every draft the row exists for is untouched: "set a loaf aside"
    // 0.96 -> 0.95, "Maya will have your order ready" 0.91 -> 0.90, "hold a
    // table at 7" 0.94 -> 0.94, the 2026-08-07 incident wording 0.57 -> 0.63,
    // and the one that must NOT be read as a standing fact - "not on the menu
    // but we'll make one for you when you come in tomorrow" - 0.90 -> 0.88.
    //
    // The row was reported on a flat-white price answer that queued at 0.38.
    // That draft split into three bubbles scored 0.27 and would have sent, so
    // before this the verdict also rode on bubble packing.
    {
      key: 'promise_leak',
      label: 'Commits the venue to a future obligation in prose',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` commit the venue to a specific future obligation - setting something aside, a person doing something at a given time, honoring a special arrangement - with NO corresponding entry in `declared_actions`?',
        criteria: {
          true: 'A guest reading this would reasonably arrive expecting the venue to have done the specific thing stated, and `declared_actions` does not carry it.',
          false:
            'No specific obligation, or it is covered by `declared_actions`. General invitations ("come by any time") are false. Stating a standing fact about the venue - a price, what is or is not on the menu, what the venue makes or sells, opening hours, or where to order - is false: a fact true of every guest is not an obligation to this one.',
        },
        threshold: 0.3,
      },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    // `provided_links` is the venue's CURATED allowlist (venue_info.links),
    // never derived from knowledge or the prompt - lib/ai/url-detector.ts
    // states the rule and the two TAC-509 rulings the criteria encode: a
    // bare domain in prose is not a link (venue corpora themselves say "on
    // venue.com"), and a schemeless link is the same destination as its
    // https:// form.
    //
    // THE VENUE'S OWN SITE IS TRUSTED AT ANY PATH (owner-ruled 2026-10-09).
    // `venueOwnDomainWildcard` appends one `https://<own-domain>/*` entry,
    // derived from `venue_info.contact.website`, and the criteria below read
    // `/*` as "any path here". Everything else still has to match exactly.
    //
    // WHY IT CHANGED, and why only the own domain. The regression harness
    // caught the cost of path-exact matching on the venue's own site: a
    // knowledge row says products are at
    // `https://lemils.com/collections/all-products`, retrieval returns it for
    // "can i buy your coffee online?", the model quotes it correctly - and
    // the allowlist carried `/collections/all` but not `/collections/all-
    // products`, so the draft queued 6/6. Every guest asking that question
    // got a held card instead of an answer. Curating a link list to
    // path-exactness against a whole storefront is not a thing anyone can
    // keep up.
    // A third-party domain gets no wildcard, because the risk the check
    // exists for is sending a guest somewhere the venue does not control, and
    // an eventbrite.com or google.com wildcard is exactly that. The own
    // domain cannot be that: the worst case is a 404 on the venue's own site.
    {
      key: 'unverified_link',
      label: 'Contains a link that was not provided by the venue',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` contain a link - a URL with a scheme (https://...) or a domain with a path (venue.com/some-page) - that is not permitted by `provided_links`?',
        criteria: {
          true: 'The text contains a link whose destination is not permitted by `provided_links`. On a domain listed WITHOUT a trailing /*, a different path or slug is still an unlisted link.',
          false:
            'Every link in the text is permitted by `provided_links`. An entry ending in `/*` permits ANY path on that domain, in EITHER form - both `https://venue.com/anything/at/all` and `venue.com/anything/at/all` are permitted when `https://venue.com/*` is listed. Otherwise the link must appear in the list (a missing https:// prefix or a single trailing slash is the same link). A bare domain with no path mentioned in prose ("order on venue.com") is not a link, and an email address is not a link.',
        },
        threshold: 0.5,
      },
      then: 'queue',
      onCheckFailure: 'closed',
    },
    {
      key: 'loyalty_language',
      label: 'Uses loyalty-program language',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` use loyalty-program framing toward the guest - points, rewards, tiers, earning, redeeming, punch cards, or "X more visits until Y"?',
        threshold: 0.7,
      },
      // Recognition-not-loyalty is listed under "Product principles (do not
      // violate)" in the root CLAUDE.md, so the conservative default is to
      // HOLD the draft: a false positive costs one operator glance, a false
      // negative puts tier-speak in front of a guest. Relaxing this to
      // 'notify' is an owner decision, recorded when made.
      then: 'queue',
      onCheckFailure: 'open',
    },
  ],
} satisfies PolicySet

/** Parsed at module load: the seed failing is a build-time catch (offline boundary, fails closed). */
export const DEFAULT_POLICY_SET: PolicySet = PolicySetSchema.parse(
  DEFAULT_POLICIES_INPUT,
)
