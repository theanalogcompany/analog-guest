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
  "notes": "[any other amenity-adjacent context — equipment status, venue quirks, etc.]"
}
```

### menu.highlights

- [Item name — price — brief context (e.g., "perfect-order anchor", "first-timer pick")]
- [Item name — price — context]
- [Item name — price — context]
- [Item name — price — context]
- [Item name — price — context]

### menu.notes

[PARAGRAPH 1 — perfect-order narrative or signature combination: what regulars order, what the venue is "in three things", any iconic pairings or rituals.]

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
    "source": "interview_section_9",
    "addedAt": "2026-01-01T00:00:00Z",
    "expiresAt": "2026-02-01T00:00:00Z"
  },
  {
    "id": "[snake_case_id]",
    "content": "[another transient operational fact]",
    "source": "interview_section_9",
    "addedAt": "2026-01-01T00:00:00Z",
    "expiresAt": "2026-03-01T00:00:00Z"
  },
  {
    "id": "[snake_case_id]",
    "content": "[another transient operational fact]",
    "source": "interview_section_9",
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
  "trigger": {
    "type": "[trigger type — e.g., guest_initiated_request, manual_invite, date_match]",
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
    "type": "[trigger type]",
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

---

## 6. voice_corpus

### Entry 1

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — 1-3 sentences from the transcript that captures distinctive operator voice — origin/identity flavor]",
  "tags": ["narrative", "[topic tag]", "[section tag]"],
  "confidence_score": 0.95
}
```

### Entry 2

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — operator's framing of why the venue exists or its mission, in their own words]",
  "tags": ["narrative", "mission", "[section tag]"],
  "confidence_score": 0.95
}
```

### Entry 3

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — about the menu: perfect-order narrative, signature item, or how the operator describes it]",
  "tags": ["menu", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

### Entry 4

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — operator's recommendation for first-timers, or framing of a particular menu item]",
  "tags": ["menu", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

### Entry 5

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — sourcing or supplier relationships: where ingredients come from, neighborhood ties]",
  "tags": ["sourcing", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

### Entry 6

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — operator's recommendations for nearby places, things they like, their corner of the world]",
  "tags": ["recommendations", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

### Entry 7

```json
{
  "source_type": "manual_entry",
  "content": "[SYNTHESIZED VOICE EXAMPLE — a paraphrased message in the operator's voice, useful when transcript doesn't have a directly applicable quote for a common interaction (e.g., a follow-up after a first visit)]",
  "tags": ["follow_up", "[topic tag]", "[section tag]"],
  "confidence_score": 0.85
}
```

### Entry 8

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — operator on how they actually talk: register, what they say to a regular vs. a stranger, what they don't say]",
  "tags": ["voice", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

### Entry 9

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — operator describing a mechanic or recurring gesture they do for regulars]",
  "tags": ["mechanic", "[topic tag]", "[section tag]"],
  "confidence_score": 0.85
}
```

### Entry 10

```json
{
  "source_type": "voicenote_transcript",
  "content": "[VERBATIM QUOTE — a behind-the-scenes detail or obsession the operator has, captures their character]",
  "tags": ["narrative", "[topic tag]", "[section tag]"],
  "confidence_score": 0.9
}
```

---

## 7. knowledge_corpus

Topical content the agent retrieves when grounding answers to substantive guest questions. Distinct from voice_corpus: these are **what is true** about the venue (origin, sourcing, staff, mechanics, philosophy, recommendations), not **how the venue texts**. Tags are topical, not situational.

### Entry 1

```json
{
  "source_type": "voicenote_transcript",
  "content": "[NARRATIVE CHUNK — sourcing or supplier relationship in the operator's words: where a key ingredient comes from, the relationship behind it, why it matters. Self-contained — readable on its own without surrounding context.]",
  "tags": ["sourcing", "[origin tag]"],
  "confidence_score": 0.9
}
```

### Entry 2

```json
{
  "source_type": "voicenote_transcript",
  "content": "[NARRATIVE CHUNK — a named staff member's personality, what they're known for, how guests experience them. E.g., who's behind the bar, what they tell first-timers, their character.]",
  "tags": ["staff_[name]", "personality"],
  "confidence_score": 0.9
}
```

### Entry 3

```json
{
  "source_type": "manual_entry",
  "content": "[SYNTHESIZED CHUNK — explanation of how a specific mechanic works in plain language, suitable for grounding the agent when a guest asks about it. Pulled from the operator's qualification + reward_description + expiration_rule fields, restated as a self-contained explanation.]",
  "tags": ["mechanic_[slug]", "explanation"],
  "confidence_score": 0.85
}
```

---

## 8. Pre-seed validation checklist

Before running `npm run seed [venue-slug]`, verify:

- [x] Narrative is 2–4 paragraphs
- [x] All 10 BrandPersonaSchema fields populated
- [x] All required VenueInfoSchema fields populated
- [x] At least 1 mechanic with structured trigger + redemption
- [x] At least 5 voice_corpus entries
- [x] At least 5 knowledge_corpus entries (substantive topical content for grounding)
- [x] At least 1 currentContext entry
- [x] Menu CSV referenced and exists in Drive

---

## 9. Notes for processing admin

Things flagged during synthesis worth knowing:

- **[FLAG NAME].** [Anomaly the operator should know about — e.g., the venue lacks a public phone and asks guests be routed to social DMs instead.]
- **[FLAG NAME].** [Another anomaly — e.g., the IG isn't operator-run, so don't scrape captions for voice corpus.]

---

## 10. Revision history

- **v01** ([YYYY-MM-DD]) — initial extraction from transcript + menu CSV + Airtable record.