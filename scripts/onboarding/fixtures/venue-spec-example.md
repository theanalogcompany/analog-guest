# Venue Spec: Central Perk

**Slug:** `mock-central-perk`
**Captured at:** 2026-04-27
**Captured by:** Jaipal Silla (manual synthesis from transcript + menu CSV + Airtable record)
**Source of truth:** This file is the seed input. Edits to this file before running `npm run seed mock-central-perk` will be reflected in Supabase. After seeding, Supabase becomes the live source of truth and this file is frozen.
**Note:** This file is a gold-standard fixture for THE-149 (extraction quality eval). Edit with care — it serves as the reference for measuring extraction script quality.

---

## 1. Venue identification

- **Name:** Central Perk
- **Slug:** mock-central-perk
- **Type:** cafe
- **Year founded:** 1994
- **Number of locations:** 1
- **Timezone:** America/New_York
- **Live:** false (flips true after smoke test passes)

---

## 2. Airtable intake (archived from form submission)

- **Analog interviewer:** Jaipal Silla
- **Submission date:** 2026-04-27
- **Drive folder:** `Analog/01. the analog company/02. Public/01. Venue Onboarding/venues/mock-central-perk/`

### Owner / operator

- **Owner:** Gunther
- **Owner email:** *(not provided)*
- **Owner phone:** *(not provided)*
- **Day-to-day point of contact:** Gunther *(same as owner)*

### Location

- **Address line 1:** 199 Bleecker St
- **Address line 2:** *(none)*
- **City:** New York
- **State:** NY
- **Postal code:** 10012
- **Neighborhood:** Greenwich Village

### Contact

- **Public phone:** *(none — Gunther never picks up; route guests to Maya's IG DMs)*
- **Public email:** centralperknyc@gmail.com *(Maya runs)*
- **Website:** https://centralperknyc.com

### Hours

| Day | Open | Close |
|---|---|---|
| Mon | 6:30am | 10:00pm |
| Tue | 6:30am | 10:00pm |
| Wed | 6:30am | 10:00pm |
| Thu | 6:30am | 10:00pm |
| Fri | 6:30am | 10:00pm |
| Sat | 7:00am | 11:00pm |
| Sun | 7:00am | 11:00pm |

- **Annual closures:** Christmas Day, July 4
- **Notes:** Gunther off Tuesdays — Maya covers

### Tools / tech stack

- **POS:** Square *(since 2018)*
- **Email marketing:** none
- **Loyalty platform:** none
- **Reservation tool:** none

### Social media

- **Instagram:** @centralperknyc
- **Run by:** Maya *(staff, not owner)*
- **Posting cadence:** weekly
- **Voice corpus relevance:** captions reflect Maya's voice, not Gunther's — DO NOT scrape captions for voice corpus

### Press / podcasts / mentions

- *Greenwich Village Reporter* (2018) — "the last cafe in the village that hasn't sold its soul"
- *NYT Metro* (2022) — fluff piece about Gunther refusing to raise prices

---

## 3. brand_persona

```json
{
  "tone": "Deadpan, sparse, lowercase, dry. Quietly observant — notices everything, says little. Warmth lives in the specifics, not the language.",
  "formality": "casual",
  "speakerFraming": "named_person",
  "speakerName": "Gunther",
  "signaturePhrases": [
    "anyway.",
    "fine.",
    "the point is",
    "couch is open",
    "on the house",
    "noticed you"
  ],
  "bannedTopics": [
    "corporate loyalty language (we miss you, earn, redeem, loyalty)",
    "enthusiasm-words (excited, amazing, incredible)",
    "exclamation points",
    "asking how someone's day is going",
    "circling back / corporate hospitality register"
  ],
  "emojiPolicy": "never",
  "lengthGuide": "Short. One line. Two if there's a reason. Never three. No paragraphs ever.",
  "voiceAntiPatterns": [
    "Don't sound enthusiastic.",
    "Don't add warmth Gunther didn't put there.",
    "Don't soften the bluntness — the bluntness IS the warmth.",
    "Don't use a friendly opener.",
    "Don't sign off."
  ],
  "voiceTouchstones": [
    "the orange couch",
    "Andrews muffins on Houston",
    "Café Integral beans from Brooklyn",
    "Phoebe's herbal tea blend",
    "the chalkboard prices haven't moved since '99",
    "couch reupholstered eight times"
  ]
}
```

---

## 4. venue_info

### narrative

> Gunther bought Central Perk from Terry in 1998 — Terry had opened it in '94 and was tired by the late nineties. Gunther had been the barista since '95 and was the only person on staff who actually wanted the place. He bought it cheap and hasn't changed much. Same orange couch in the middle of the room — reupholstered eight times since, same fabric Gunther bought up the last forty yards of in 2003, same dye from a small shop in Queens.
>
> Two of the prices on the chalkboard haven't moved since 1999. Central Perk is in Greenwich Village on Bleecker and has been one of the village's institutions for thirty years. Regulars met their spouses here, wrote books here, came back the day after a heart attack.
>
> Gunther doesn't call it a mission. He calls it a couch and a door.

### staff

```json
[
  {
    "name": "Gunther",
    "role": "owner / operator",
    "notes": "Every day except Tuesdays. Bought the place from Terry in 1998 after working there as a barista since 1995."
  },
  {
    "name": "Maya",
    "role": "weekend lead",
    "notes": "4 years. Came over from Joe's Coffee in the Village. Runs the Instagram. Regulars love her. Latte art (kids ask her to draw cats in the foam)."
  },
  {
    "name": "Joon",
    "role": "weekday morning barista",
    "notes": "6 months. Came from Ralph's Coffee in midtown. Knows espresso better than Gunther at this point."
  }
]
```

### amenities

```json
{
  "wifi": true,
  "petFriendly": false,
  "parking": "street only — Greenwich Village",
  "seating": "Capacity ~22 seated. Orange couch (4–5 people, in demand). Green armchair on the right. Coffee table. Two-top on the left. Six small two-tops behind the main seating area.",
  "notes": "Backup La Marzocco espresso machine in the basement, currently running as the front machine while parts come in (April 2026)."
}
```

### menu.highlights

- Double latte ($2.75) — perfect-order anchor
- Cappuccino ($2.25) — first-timer recommendation, "the right size for sitting"
- Blueberry muffin from Andrews on Houston ($2.00)
- Herbal tea ($1.25) — ask for the Phoebe blend
- The Rachel (off-menu) — caramel macchiato with extra foam
- The Joey (off-menu, regulars only) — meatball sub from Carmine's Deli, $7
- The Phoebe herbal tea blend — chamomile, lavender, dried orange peel

### menu.notes

The perfect order is a double latte, a blueberry muffin, and a seat on the orange couch. Most of the menu hasn't changed since Terry set it in 1994. Cappuccino is Gunther's recommendation for first-timers — not for the foam, but because it's the right size for sitting.

Off-menu, by request: "the Rachel" (caramel macchiato with extra foam — a regular's drink, kept on for people who know to ask), "the Joey" (regulars only — Gunther will run to Carmine's Deli next door and bring back a meatball sub for $7), "the Phoebe" herbal tea blend (chamomile, lavender, dried orange peel — a regular's recipe, still made for people who ask).

Beans from Café Integral, a Brooklyn roaster whose owner wrote his thesis on the couch. Muffins from Andrews on Houston, three blocks away, third-generation family bakery. Bagels from Murray's around the corner. Two prices haven't changed since 1999.

### menu.items

See `05-mock-central-perk-menu.csv` in the Drive folder. 22 rows: 19 on-menu items + 3 off-menu specials. No sized items (Gunther doesn't do sizes). Modifiers for oat milk / almond milk on coffee drinks. Sourcing notes inline (Andrews muffins, Murray's bagels, Café Integral beans).

### currentContext

```json
[
  {
    "id": "ccx_apr_open_mic",
    "content": "Phoebe's monthly open mic: Saturday April 18, 6pm. Sign-ups at the counter or by text. Regulars get priority on better slots.",
    "source": "interview_section_9",
    "addedAt": "2026-04-27T00:00:00Z",
    "expiresAt": "2026-04-19T00:00:00Z"
  },
  {
    "id": "ccx_spring_tea",
    "content": "Spring herbal tea blend through May: chamomile, hibiscus, dried orange peel. Different from the year-round 'Phoebe blend' (chamomile, lavender, dried orange). Same price as the standard herbal tea — $1.25.",
    "source": "interview_section_9",
    "addedAt": "2026-04-27T00:00:00Z",
    "expiresAt": "2026-06-01T00:00:00Z"
  },
  {
    "id": "ccx_espresso_machine",
    "content": "Front espresso machine on the fritz since early April — running on the backup La Marzocco from the basement. Quality unchanged. Most guests can't tell. Likely to continue through the month while parts come in.",
    "source": "interview_section_9",
    "addedAt": "2026-04-27T00:00:00Z",
    "expiresAt": "2026-05-15T00:00:00Z"
  }
]
```

---

## 5. mechanics

### Mechanic 1: couch hold

```json
{
  "type": "perk",
  "name": "couch hold",
  "min_state": "regular",
  "qualification": "Regulars Gunther personally recognizes. Known by sight or name.",
  "description": "Gunther will hold the orange couch for a regular if they text ahead. He gives the current occupants a fifteen-minute heads-up. The couch is the most contested seating in the venue — holding it is a meaningful gesture.",
  "reward_description": "The orange couch reserved on arrival.",
  "expiration_rule": "Per-request only — regular has to text ahead each time.",
  "trigger": {
    "type": "guest_initiated_request",
    "method": "text_message"
  },
  "redemption": {
    "type": "manual_owner_action_at_venue"
  }
}
```

### Mechanic 2: phoebe open mic

```json
{
  "type": "event_invite",
  "name": "phoebe open mic",
  "min_state": "regular",
  "qualification": "Regulars Gunther personally vouches for. Curated, not algorithmic.",
  "description": "Monthly open mic on the third Saturday of the month. Started by a regular ten years ago, still runs it. Regulars get priority on better slots.",
  "reward_description": "Priority slot at the next open mic — sign up at the counter or by text.",
  "expiration_rule": "Invitation valid for that month's open mic only.",
  "trigger": {
    "type": "manual_invite",
    "cadence": "monthly",
    "schedule": "third_saturday"
  },
  "redemption": {
    "type": "rsvp_via_text"
  }
}
```

---

## 6. voice_corpus

### Entry 1

```json
{
  "source_type": "voicenote_transcript",
  "content": "I'm not a coffee guy. I'm a cafe guy. There's a difference. A coffee guy obsesses over the bean. A cafe guy obsesses over what happens after the cup is in someone's hand.",
  "tags": ["narrative", "philosophy", "section_2"],
  "confidence_score": 0.95
}
```

### Entry 2

```json
{
  "source_type": "voicenote_transcript",
  "content": "A place where you come back. That's all. I don't have a mission. I have a couch and a door.",
  "tags": ["narrative", "mission", "section_2"],
  "confidence_score": 0.95
}
```

### Entry 3

```json
{
  "source_type": "voicenote_transcript",
  "content": "Double latte, blueberry muffin, sit on the couch. That's the place in three things. The latte is fine. The muffin is from Andrews on Houston, they bake daily. The couch you have to wait for. If you got all three, you've had Central Perk.",
  "tags": ["menu", "perfect_order", "section_3"],
  "confidence_score": 0.9
}
```

### Entry 4

```json
{
  "source_type": "voicenote_transcript",
  "content": "Cappuccino. We don't do anything fancy with the foam. People expect the cafe to wow them. We don't. The point is you sit down. The cappuccino is the right size for sitting.",
  "tags": ["menu", "first_timer_recommendation", "section_3"],
  "confidence_score": 0.9
}
```

### Entry 5

```json
{
  "source_type": "voicenote_transcript",
  "content": "Beans are from Café Integral, a small Brooklyn roaster. Owner used to come in and write his thesis on the couch. When he started his roastery he asked if we'd buy from him. We do. Muffins from Andrews on Houston. Bagels from Murray's around the corner. I don't shop more than ten blocks from here.",
  "tags": ["sourcing", "section_3", "their_world"],
  "confidence_score": 0.9
}
```

### Entry 6

```json
{
  "source_type": "voicenote_transcript",
  "content": "Joe's Pizza on Carmine for a slice. Caffe Reggio on MacDougal — older than me, older than this place, the cappuccino is fine but the room is the point. Magnolia Bakery for the cupcake even though it's a tourist line, they're still good. Russ & Daughters across town for the bagel with whitefish, worth the trip.",
  "tags": ["recommendations", "their_world", "nyc", "section_6"],
  "confidence_score": 0.9
}
```

### Entry 7

```json
{
  "source_type": "manual_entry",
  "content": "you came in yesterday. couch was full. it's usually open weekday afternoons if you want it. herbal tea's on the house next time. anyway.",
  "tags": ["follow_up", "first_visit", "verbatim_owner_exercise", "section_7"],
  "confidence_score": 0.95
}
```

### Entry 8

```json
{
  "source_type": "voicenote_transcript",
  "content": "I don't say much to either. To a stranger I say what they ordered, the price, and 'next' if there's a line. To a regular I might say 'couch in twenty,' or 'Joon made it weak today,' or nothing at all. Mostly nothing.",
  "tags": ["voice", "regular_vs_stranger", "section_7"],
  "confidence_score": 0.9
}
```

### Entry 9

```json
{
  "source_type": "voicenote_transcript",
  "content": "I hold the couch. If someone I know texts me they're coming, I tell whoever's on it that they need to wrap up in fifteen. Most regulars don't ask. The ones who do, I do it for.",
  "tags": ["mechanic", "couch_hold", "section_8"],
  "confidence_score": 0.85
}
```

### Entry 10

```json
{
  "source_type": "voicenote_transcript",
  "content": "I reupholster it every two years. Same fabric — it's discontinued, I bought up the last forty yards in 2003 and I keep it in the basement. Same dye. There's a guy in Queens, his shop's called Marquette Tannery, he does the orange. People sit on it and have no idea it's been recovered eight times.",
  "tags": ["narrative", "obsession", "behind_the_scenes", "section_2"],
  "confidence_score": 0.9
}
```

---

## 7. Pre-seed validation checklist

Before running `npm run seed mock-central-perk`, verify:

- [x] Narrative is 2–4 paragraphs (3 paragraphs)
- [x] All 10 BrandPersonaSchema fields populated
- [x] All required VenueInfoSchema fields populated
- [x] At least 1 mechanic with structured trigger + redemption (2 mechanics)
- [x] At least 5 voice_corpus entries (10 entries)
- [x] At least 1 currentContext entry (3 entries)
- [x] Menu CSV referenced and exists in Drive

---

## 8. Notes for processing admin

Things flagged during synthesis worth knowing:

- **No public phone.** Gunther confirmed in Section 9 that the phone exists but goes unanswered. Routing question for the agent: if a guest asks for a phone number, the agent should NOT give it. Direct to Maya's IG DMs (@centralperknyc) instead. Worth a small note in the agent's system prompt.
- **POS = Square.** Captured in Section 9. Means this venue is eligible for THE-134 POS integration when that ships.
- **Owner does NOT run IG.** Maya runs it. IG captions reflect Maya's voice, not Gunther's. Do NOT scrape captions for voice corpus on this venue.
- **Backup espresso machine.** Currently running on the backup La Marzocco from the basement. Captured in `currentContext` with expiry 2026-05-15. Admin should refresh this entry once Gunther reports the front machine is fixed.
- **Andrews muffins are not on menu.** They're sourced — but the relationship is so old (third generation, Christmas card every year) that Gunther sees the muffins AS Central Perk in some way. Voice corpus reflects this. The agent should reference Andrews when discussing pastries.
- **Mechanic min_state defaulted to `regular`.** Gunther's qualification language ("regulars I personally recognize") translates cleanly to that bucket per the playbook extraction table. Operator can grant either mechanic manually to anyone below the floor at runtime.

---

## 9. Revision history

- **v01** (2026-04-27) — initial synthesis from interview transcript + menu CSV + Airtable record. Manual extraction by Jaipal Silla. Serves as gold-standard fixture for THE-149 (extraction quality eval harness).
