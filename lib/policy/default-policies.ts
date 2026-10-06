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
// The semantic rows all ask the DISCREPANCY question - "...not covered by
// `declared_actions`" - never the open-ended one. A draft that declared its
// comp as an action is already queued by the structural row; the Noul exists
// to catch the leak, and a matching declared action is exonerating context.

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
    {
      key: 'complaint_requires_approval',
      label: 'Reply to a complaint',
      detection: { kind: 'always' },
      conditions: { situations: ['complaint'] },
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
    // Semantic: the prose-leak backstops.
    //
    // The standing-policy clause in comp_leak's false criteria is owner-ruled
    // (2026-10-05): "orders over $50 ship free" is the store's published
    // policy, straight from the venue's knowledge - not a per-guest giveaway.
    // Measured matching 3/3 on the bare-domain-link scenario before the
    // clause (p crossed the 0.3 placeholder threshold); that scenario now
    // forbids comp_leak so the lesson stays enforced.
    {
      key: 'comp_leak',
      label: 'Free or discounted item promised in prose only',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` promise the guest something free, discounted, or "on us" that has NO corresponding entry in `declared_actions`?',
        criteria: {
          true: 'The text offers a concrete free or discounted item, drink, or treat and `declared_actions` contains no matching offer. Vague warmth ("next time\'s on me" as a clear offer) counts as true.',
          false:
            'No giveaway is promised, or every promise in the text matches an entry in `declared_actions`. Friendly language with no concrete commitment ("hope to see you soon") is false. Stating a standing store policy that applies to every customer (free shipping over a threshold, a published deal) is false - a policy is not a per-guest giveaway.',
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
            'No specific obligation, or it is covered by `declared_actions`. General invitations ("come by any time") are false.',
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
    {
      key: 'unverified_link',
      label: 'Contains a link that was not provided by the venue',
      detection: {
        kind: 'semantic',
        instructions:
          'Does `draft_messages` contain a link - a URL with a scheme (https://...) or a domain with a path (venue.com/some-page) - that does not appear in `provided_links`?',
        criteria: {
          true: 'The text contains a link whose destination is not listed in `provided_links`. A different path or slug on a listed domain is still an unlisted link.',
          false:
            'Every link in the text appears in `provided_links` (a missing https:// prefix or a single trailing slash is the same link). A bare domain with no path mentioned in prose ("order on venue.com") is not a link, and an email address is not a link.',
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
