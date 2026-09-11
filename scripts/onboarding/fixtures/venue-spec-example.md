# Venue Spec: [VENUE NAME]

> **Format example only.** This document shows the structure and section ordering
> expected from the extract-venue-spec script. All content is placeholder text.
> The extraction script must produce a document with the SAME structure but with
> content drawn entirely from the venue's transcript, menu, and Airtable record.

---

## 1. Venue identification

- **Name:** [VENUE NAME]
- **Slug:** [venue-slug]
- **Type:** [cafe | bakery | restaurant | etc.]
- **Year founded:** [YYYY]
- **Number of locations:** [number]
- **Timezone:** [IANA timezone, e.g. America/Los_Angeles]
- **Live:** false

---

## 2. Airtable intake (archived from form submission)

- **Analog interviewer:** [INTERVIEWER NAME]
- **Submission date:** [YYYY-MM-DD]
- **Drive folder:** `Analog/01. the analog company/02. Public/01. Venue Onboarding/venues/[venue-slug]/`

### Owner / operator

- **Owner:** [OWNER NAME]
- **Owner email:** [OWNER EMAIL or *(not provided)*]
- **Owner phone:** [OWNER PHONE or *(not provided)*]
- **Day-to-day point of contact:** [CONTACT NAME] *(role / relationship to owner)*

### Location

- **Address line 1:** [ADDRESS LINE 1]
- **Address line 2:** [ADDRESS LINE 2 or *(none)*]
- **City:** [CITY]
- **State:** [STATE]
- **Postal code:** [POSTAL]
- **Neighborhood:** [NEIGHBORHOOD]

### Contact

- **Public phone:** [PUBLIC PHONE or *(none)*]
- **Public email:** [PUBLIC EMAIL or *(none)*]
- **Website:** [WEBSITE or *(none)*]

### Hours

| Day | Open | Close |
|---|---|---|
| Mon | [Open] | [Close] |
| Tue | [Open] | [Close] |
| Wed | [Open] | [Close] |
| Thu | [Open] | [Close] |
| Fri | [Open] | [Close] |
| Sat | [Open] | [Close] |
| Sun | [Open] | [Close] |

- **Annual closures:** [closure dates or *(none)*]
- **Notes:** [staffing or hours-related notes or *(none)*]

### Tools / tech stack

- **POS:** [POS provider or *(none)*]
- **Email marketing:** [provider or *(none)*]
- **Loyalty platform:** [provider or *(none)*]
- **Reservation tool:** [provider or *(none)*]

### Social media

- **Instagram:** [@handle or *(none)*]
- **Run by:** [STAFF NAME or *(owner)*]
- **Posting cadence:** [cadence, e.g., weekly / daily / sporadic]
- **Voice corpus relevance:** [whether captions reflect the operator's voice — DO scrape / DO NOT scrape]

### Press / podcasts / mentions

- *[OUTLET NAME]* ([year]) — [quote or summary of mention]
- *[OUTLET NAME]* ([year]) — [quote or summary of mention]

---

## 3. brand_persona

```json
{
  "tone": "[1-3 sentences describing voice register: e.g., deadpan and dry / warm and conversational / playful and energetic — pulled from the operator's voice in the transcript]",
  "formality": "[casual | warm | formal]",
  "speakerFraming": "[venue | named_person | owner]",
  "speakerName": "[required string when speakerFraming=named_person, else omit this field]",
  "signaturePhrases": [
    "[verbatim phrase from transcript]",
    "[another verbatim phrase]"
  ],
  "bannedTopics": [
    "[topic the operator wants avoided]",
    "[another banned topic]"
  ],
  "emojiPolicy": "[never | sparingly | frequent]",
  "lengthGuide": "[1-2 sentences describing message length conventions, in operator's voice]",
  "voiceAntiPatterns": [
    "[concrete rule about what NOT to do, in operator's voice]",
    "[another anti-pattern]"
  ],
  "voiceTouchstones": [
    "[recurring concrete reference — place, phrase, menu item, etc.]",
    "[another touchstone]"
  ]
}
```

---

## 4. venue_info

### narrative

> [NARRATIVE PARAGRAPH 1 — 2-4 sentences in the operator's voice covering the venue's origin, identity, or core character. Concrete and specific. No marketing register.]
>
> [NARRATIVE PARAGRAPH 2 — what makes this venue distinct: location, history, regulars, signature objects/spaces, evolution.]
>
> [NARRATIVE PARAGRAPH 3 — the operator's framing of why the venue exists / what it's for, in their own words.]

### staff

```json
[
  {
    "name": "[STAFF NAME]",
    "role": "[role at venue]",
    "notes": "[brief context — tenure, notable trait, schedule]"
  },
  {
    "name": "[STAFF NAME]",
    "role": "[role at venue]",
    "notes": "[brief context]"
  }
]
```

### amenities

```json
{
  "wifi": true,
  "petFriendly": false,
  "parking": "[parking situation, e.g., street only / lot / valet / *(none)*]",
  "seating": "[capacity + seating layout — concrete details about chairs, tables, contested spots, etc.]",
  "notes": "[any other amenity-adjacent context — venue quirks, etc.]"
}
```

### menu.highlights

- [Item name — price — a short factual note: flavor profile, format, or what makes it notable. A structured fact about the item, not a recommendation or endorsement.]
- [Item name — price — factual note]
- [Item name — price — factual note]
- [Item name — price — factual note]
- [Item name — price — factual note]

### menu.notes

[PARAGRAPH 1 — perfect-order narrative or signature combination: what regulars order, what the venue is "in three things", any iconic pairings or rituals. Phrase as description of the venue ("regulars default to X"), not as advice to the reader ("suggest X to newcomers"). If the operator instead gave an opinionated pick or recommendation for a type of guest, that belongs in knowledge_corpus (section 7) with primary_tags: ["recommendations"], not here.]

[PARAGRAPH 2 — off-menu items and how they're requested: regulars-only items, by-request specials, the social rules around them.]

[PARAGRAPH 3 — sourcing and supplier relationships: where ingredients come from, vendor stories, any neighborhood ties.]

### menu.items

See `04-[venue-slug]-menu.csv` in the Drive folder. CSV is the source-of-truth for structured menu lookups; this section is a pointer only. Item count, sized variants, modifiers, and sourcing notes live in the CSV.

### currentContext

```json
[
  {
    "id": "[snake_case_id]",
    "content": "[transient operational fact — equipment status, seasonal item, event date]",
    "source": "interview_operating_reality",
    "addedAt": "2026-01-01T00:00:00Z",
    "expiresAt": "2026-02-01T00:00:00Z"
  },
  {
    "id": "[snake_case_id]",
    "content": "[another transient operational fact]",
    "source": "interview_operating_reality",
    "addedAt": "2026-01-01T00:00:00Z",
    "expiresAt": "2026-03-01T00:00:00Z"
  },
  {
    "id": "[snake_case_id]",
    "content": "[another transient operational fact]",
    "source": "interview_operating_reality",
    "addedAt": "2026-01-01T00:00:00Z",
    "expiresAt": "2026-02-15T00:00:00Z"
  }
]
```

---

## 5. mechanics

### Mechanic 1: [mechanic name]

```json
{
  "type": "[perk | referral | content_unlock | event_invite | merch]",
  "name": "[MECHANIC NAME]",
  "min_state": "[new | returning | regular | raving_fan]",
  "qualification": "[QUALIFICATION RULE in operator's words — who gets this and why]",
  "description": "[2-3 sentences describing the mechanic in operator's voice]",
  "reward_description": "[what the guest receives, in concrete terms]",
  "expiration_rule": "[when/how it expires]",
  "redemption_policy": "one_time",
  "requires_operator_approval": true,
  "trigger": {
    "type": "[trigger type — one of: guest_initiated_request, manual_invite]",
    "method": "[delivery method or other trigger-specific field]"
  },
  "redemption": {
    "type": "[redemption type — e.g., manual_owner_action_at_venue, rsvp_via_text]"
  }
}
```

### Mechanic 2: [mechanic name]

```json
{
  "type": "[perk | referral | content_unlock | event_invite | merch]",
  "name": "[MECHANIC NAME]",
  "min_state": "[new | returning | regular | raving_fan]",
  "qualification": "[QUALIFICATION RULE in operator's words]",
  "description": "[2-3 sentences describing the mechanic]",
  "reward_description": "[what the guest receives]",
  "expiration_rule": "[when/how it expires]",
  "redemption_policy": "renewable",
  "redemption_window_days": 30,
  "trigger": {
    "type": "[trigger type — one of: guest_initiated_request, manual_invite]",
    "cadence": "[e.g., monthly]",
    "schedule": "[e.g., third_saturday]"
  },
  "redemption": {
    "type": "[redemption type]"
  }
}
```

> Notes on the new fields (THE-170):
> - `min_state`: gates eligibility by the guest's relationship band. Mechanic does not appear in the agent's prompt for guests below this band.
> - `redemption_policy`: `one_time` blocks future re-offers permanently after a single `mechanic_redeemed` event. `renewable` resets after `redemption_window_days` days (e.g. 30 = monthly, 7 = weekly). Most mechanics are `one_time`; renewable is for repeating perks like a free first drink each month.
> - Omit `redemption_policy` and `redemption_window_days` to default to `one_time` / null. Renewable mechanics MUST set both.
> - `requires_operator_approval` (TAC-346): bias toward `true` — set it when the operator wants to decide personally, or the mechanic commits their time/a limited slot/their personal discretion. Omit (defaults `false`) only when staff or the agent can grant it freely, as Mechanic 2 above does. Every mechanic's value is listed in Needs confirmation with its source quote (or "none, defaulted") regardless of which way it's set.

---

## 6. voice_corpus

### Entry 1

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM OR NEAR-VERBATIM TEXT — a message the operator actually sent, or would send, welcoming a guest back after a previous visit. Addressed TO a guest, not about the business.]",
  "tags": ["welcome", "[topic tag]", "[section tag]"],
  "confidence_score": 0.95
}
```

### Entry 2

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM OR NEAR-VERBATIM TEXT — a message the operator actually sent, or would send, answering a guest's question (hours, an item, a request). Addressed TO a guest, not a description of how they'd answer.]",
  "tags": ["reply", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

### Entry 3

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM OR NEAR-VERBATIM TEXT — a short follow-up message the operator actually sent, or would send, after a guest's visit. Addressed TO a guest, not the operator narrating that they follow up.]",
  "tags": ["follow_up", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

### Entry 4

```json
{
  "source_type": "voicenote_transcript",
  "content": "[SHORT SPOKEN LINE — something the operator would plausibly say to a guest across the counter: a recommendation, an invitation, or a house rule said warmly. Second person, one or two sentences, trimmed of filler. Not a text message — a line of spoken voice. Not a long narrative or reflective passage about the business, and not addressed to the interviewer.]",
  "tags": ["recommendation", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

---

## 7. knowledge_corpus

Content the agent retrieves when grounding answers to substantive guest questions — both NARRATIVE (**stories, explanations, and context** behind the venue: origin, sourcing relationships, staff personalities, mechanic explanations, philosophy, opinionated recommendations) and OPERATIONAL FACTS (plain policies and logistics venue_info has no field for: tipping, walk-ins-only, delivery, shipping, wholesale, catering, private events, merch, and similar). Distinct from voice_corpus (style examples) and from venue_info (structured facts like hours/menu/staff list).

Each entry has TWO tag arrays:

- **`primary_tags`** — closed enum, used for retrieval routing. Choose one or more from: `sourcing`, `staff`, `mechanic`, `menu`, `philosophy`, `recommendations`, `events`, `history`, `space`, `policies`, `logistics`, `other`. Namespacing allowed: `staff_phoebe` (matches `staff`), `mechanic_perk_card` (matches `mechanic`). A chunk that spans topics carries multiple primary tags.
- **`secondary_tags`** — free-form, descriptive. 2–5 typical. Doesn't drive routing; helps the agent contextualize what was matched.

**Granularity: one entry per self-contained claim, not one entry per topic.** If the operator discusses several items in one breath — five signature drinks, three neighborhood policies — write one entry per item. A single entry covering all five drinks retrieves on every question about any one of them and dilutes the match; five entries let a question about the cortado retrieve only the cortado. Each entry's content must name its own subject — it is embedded and retrieved alone, with no memory of the surrounding conversation. "Good entry point, lets the coffee speak" is not a usable entry on its own; "The pour-over is a good entry point — it lets the coffee speak for itself" is. Do not rely on chunking to separate subjects for you; split at extraction time.

### Entry 1

```json
{
  "source_type": "voicenote_transcript",
  "content": "[NARRATIVE CHUNK — sourcing or supplier relationship in the operator's words: where a key ingredient comes from, the relationship behind it, why it matters. Self-contained — readable on its own without surrounding context.]",
  "primary_tags": ["sourcing"],
  "secondary_tags": ["[origin region]", "[supplier name]"],
  "confidence_score": 0.9
}
```

### Entry 2

```json
{
  "source_type": "voicenote_transcript",
  "content": "[NARRATIVE CHUNK — a named staff member's personality, what they're known for, how guests experience them. E.g., who's behind the bar, what they tell first-timers, their character.]",
  "primary_tags": ["staff_[name]"],
  "secondary_tags": ["personality", "[role]"],
  "confidence_score": 0.9
}
```

### Entry 3

```json
{
  "source_type": "manual_entry",
  "content": "[SYNTHESIZED CHUNK — explanation of how a specific mechanic works in plain language, suitable for grounding the agent when a guest asks about it. Pulled from the operator's qualification + reward_description + expiration_rule fields, restated as a self-contained explanation.]",
  "primary_tags": ["mechanic_[slug]"],
  "secondary_tags": ["explanation"],
  "confidence_score": 0.85
}
```

### Entry 4 (multi-primary example)

```json
{
  "source_type": "voicenote_transcript",
  "content": "[NARRATIVE CHUNK — a chunk that spans topics, e.g., a story about a named staff member's seasonal drink experiments. Belongs to BOTH `menu` (it's about a drink) AND `staff_<name>` (it's about who makes it). Carry both primary tags so retrieval surfaces it for either routing path.]",
  "primary_tags": ["menu", "staff_[name]"],
  "secondary_tags": ["seasonal", "[drink type]"],
  "confidence_score": 0.9
}
```

### Entry 5 (opinionated recommendation — routes here, never to venue_info)

```json
{
  "source_type": "voicenote_transcript",
  "content": "[NARRATIVE CHUNK — the operator's own opinionated pick or recommendation, attributed and in indicative mood: knowledge Sana holds and may choose to mention, not an instruction she must follow. E.g., what the operator would point a first-timer toward and why. Phrase it as 'the owner's pick is...' or 'the operator would point a first-timer toward...' — never as 'always suggest...' or 'don't over-program...'. This content NEVER belongs in venue_info.menu.highlights or menu.notes, even when the operator phrased it as a plain fact.]",
  "primary_tags": ["recommendations"],
  "secondary_tags": ["[topic, e.g. menu item]", "[occasion, e.g. first_visit]"],
  "confidence_score": 0.9
}
```

### Entry 6 (operational fact — policy)

```json
{
  "source_type": "voicenote_transcript",
  "content": "[OPERATIONAL FACT — a plain policy the operator stated: tipping, walk-ins-only, no delivery, or similar. A complete, self-contained fact — it does not need a story around it to belong here.]",
  "primary_tags": ["policies"],
  "secondary_tags": ["[topic, e.g. tipping]"],
  "confidence_score": 0.9
}
```

### Entry 7 (operational fact — logistics)

```json
{
  "source_type": "voicenote_transcript",
  "content": "[OPERATIONAL FACT — a logistics detail: how ordering, shipping, wholesale, catering, or private events actually work, distinct from the venue's posted hours or address.]",
  "primary_tags": ["logistics"],
  "secondary_tags": ["[topic, e.g. catering_lead_time]"],
  "confidence_score": 0.9
}
```

---

## 8. Notes for processing admin

Things flagged during synthesis worth knowing:

- **[FLAG NAME].** [Anomaly the operator should know about — e.g., the venue lacks a public phone and asks guests be routed to social DMs instead.]
- **[FLAG NAME].** [Another anomaly — e.g., the IG isn't operator-run, so don't scrape captions for voice corpus.]

---

## 9. Revision history

- **v01** ([YYYY-MM-DD]) — initial extraction from transcript + menu CSV + Airtable record.