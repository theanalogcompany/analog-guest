# Test Scenarios Fixture

This file is consumed by `extract-test-scenarios` (THE-180) during venue onboarding. The extraction script reads this fixture along with the venue-spec and generates a list of venue-tailored test scenarios written to `07-{slug}-test-scenarios.json`. The runner script `run-test-scenarios` (THE-181) then executes those scenarios against the agent and writes results to `08-{slug}-response-review` (gsheet) for owner review.

## Universal voice rules (referenced as R1–R7 below)

These rules live in `SYSTEM_TEMPLATE` (PROMPT_VERSION v1.1.0+) and apply to every agent on every venue. Test categories below cite the rules they exercise so reviewers can quickly identify which rule a failure violates.

- **R1**: Don't reference actions the guest didn't take
- **R2**: Default to today's specific answer when guests ask about "now"
- **R3**: Never use em dashes — use periods, commas, or shorter sentences (universal across all categories — not re-cited per category)
- **R4**: Never reference physical artifacts the agent doesn't have ("in front of me")
- **R5**: Don't refer guests to alternative channels for things the venue can answer
- **R6**: Answer yes/no questions with yes/no — don't enumerate
- **R7**: Don't restate context already covered in the conversation (atomic v1 scenarios test this only partially — true R7 testing requires multi-turn flows, deferred)

## Format

Each category has:

- **description**: what the category tests, including which rules it exercises
- **target_count**: number of distinct inbound messages to generate per venue
- **guest_states**: `['any']` for state-independent (runner uses `new`), or `['new', 'regular', ...]` for matrix
- **expected_failure** (optional): marker like `THE-170` or `mechanics_flow_immature`. Runner pre-populates the comment column with `expected_failure: {value}` and THE-178 ingestion will skip these rows
- **example_phrasings**: 2–4 reference phrasings for Sonnet's pattern-matching. Not templates — Sonnet adapts to the venue's voice and offerings.

## Venue-specific scenarios (auto-derived)

In addition to the categories below, the extraction script derives extra scenarios from the venue-spec's mechanics. For each mechanic:

- One scenario at `guest_state` = the mechanic's `min_state` → expect agent honors the mechanic
- One scenario at `guest_state` = 'new' (if `min_state` ≠ 'new') → expect agent declines because the guest hasn't earned access

---

## Categories

### Category 1: greeting

- **description**: First-contact message from a guest who hasn't messaged the venue before. Tests **R1** (the canonical case — agent should not say "thanks for stopping by" or "you tapped in" when the only signal is an inbound text). Also tests opener tone discipline.
- **target_count**: 1
- **guest_states**: `['new']`
- **example_phrasings**:
  - "hi"
  - "hey"
  - "what's up"

### Category 2: hours

- **description**: Guest asks about closing time, opening time, or whether the venue is open right now. Tests **R2** (the canonical case — give today's answer, not the full-week schedule). When phrased as yes/no ("are you open?"), also tests **R6**.
- **target_count**: 1
- **guest_states**: `['any']`
- **example_phrasings**:
  - "what time do you close?"
  - "are you open right now?"
  - "open today?"
  - "what time do you close tonight?"

### Category 3: recommendation

- **description**: Guest asks for a recommendation. Tests recommendation hygiene — agent should recommend without bloating the response with sourcing detail or enumeration. Stays in venue voice rather than defaulting to marketing copy. Often pairs with venue-specific anti-patterns ("don't include sourcing detail"). Tested across `new`, `returning`, and `regular` because the agent should plausibly lean on visit history at higher relationship states.
- **target_count**: 2
- **guest_states**: `['new', 'returning', 'regular']`
- **example_phrasings**:
  - "what do you recommend?"
  - "what should i get?"
  - "first time here, what's good?"
  - "what's your favorite?"

### Category 4: menu fact

- **description**: Guest asks a yes/no question about whether the venue serves a specific item. Tests **R6** (the canonical case — yes/no answer, not enumeration). When agent doesn't know, tests **R5** (don't redirect to email/web for menu questions).
- **target_count**: 2
- **guest_states**: `['any']`
- **example_phrasings**:
  - "do you have iced tea?"
  - "got any pastries?"
  - "do you serve breakfast?"

### Category 5: menu modifier availability

- **description**: Guest asks about a menu modifier (milk options, decaf, iced/hot, etc.). Tests **R6** (yes/no discipline) and venue-info menu accuracy. When agent hedges — as in the canonical second-oat-milk failure — also tests **R4** ("don't have it in front of me") and **R5** (don't redirect to email).
- **target_count**: 2
- **guest_states**: `['any']`
- **example_phrasings**:
  - "do you have oat milk?"
  - "can i get my latte iced?"
  - "do you have decaf?"

### Category 6: pricing

- **description**: Guest asks how much something costs. Tests direct-answer discipline. When agent doesn't know, tests **R4** ("don't have prices in front of me") and **R5** (don't redirect to website). When phrased yes/no ("is it expensive?"), also tests **R6**.
- **target_count**: 1
- **guest_states**: `['any']`
- **example_phrasings**:
  - "how much is a cappuccino?"
  - "what does a latte cost?"
  - "are your pastries expensive?"

### Category 7: busy / wait times

- **description**: Guest asks if the venue is busy now or how long the wait will be. Tests **R4** (agent can't see real-time floor state, but should acknowledge that without claiming to "check" or "look at" anything). Tests **R5** (canonical case — agents are tempted to redirect to "call the venue" or "check our hours" when they should just answer with what they know).
- **target_count**: 1
- **guest_states**: `['any']`
- **example_phrasings**:
  - "is it busy right now?"
  - "how long is the wait?"
  - "should i come now or later?"

### Category 8: reservations / hold for me

- **description**: Guest asks the venue to save, hold, or reserve something for them. Tests graduated authority (THE-91) — `new` guest declined per venue policy, `regular` may be accommodated, `raving_fan` may be granted with more latitude. Multi-turn risk if guest persists also exercises **R7** (don't restate context).
- **target_count**: 1
- **guest_states**: `['new', 'regular', 'raving_fan']`
- **example_phrasings**:
  - "can you save me a table?"
  - "can you hold one for me?"
  - "reserve the corner spot for me?"

### Category 9: allergy / dietary

- **description**: Guest asks about allergens, dietary restrictions, or ingredients. Tests **R6** (most are yes/no — "is the bread vegan?"). Tests **R4** (don't claim to check ingredient lists you can't physically see). When unsure, tests **R5** (don't redirect to "ask the chef" if the agent should be able to answer from venue-info).
- **target_count**: 2
- **guest_states**: `['any']`
- **example_phrasings**:
  - "any nut-free options?"
  - "do you have anything gluten-free?"
  - "is your bread vegan?"

### Category 10: situational facts

- **description**: Pet/kid/wifi/parking/outlets/payments — operational facts about the space. Tests **R6** (these are almost always yes/no). Tests venue-info coverage.
- **target_count**: 2
- **guest_states**: `['any']`
- **example_phrasings**:
  - "is the place dog-friendly?"
  - "do you have wifi?"
  - "is there parking nearby?"
  - "outlets for laptops?"

### Category 11: off-menu / regulars-only

- **description**: Guest requests an off-menu item or regulars-only perk. Tests min_state eligibility on mechanics — `new`-state guests should be declined; `regular`-state guests should be honored.
- **target_count**: 1
- **guest_states**: `['new', 'regular']`
- **example_phrasings**:
  - "can i get the joey?"
  - "the usual?"
  - "anything off-menu today?"

### Category 12: comp / complaint

- **description**: Guest reports a quality issue or complaint. Tests softener discipline (no "I'll be honest" or other apologetic openers — venue-specific anti-patterns from Phase 5). Tests authority discipline (don't over-commit to comping without operator approval). Tested across all four states because authority to comp and apology tone scale with relationship strength.
- **target_count**: 1
- **guest_states**: `['new', 'returning', 'regular', 'raving_fan']`
- **example_phrasings**:
  - "the latte was burnt"
  - "i waited 20 minutes"
  - "wasn't great today"

### Category 13: casual chatter

- **description**: Social, non-transactional message. Tests voice-register discipline — should match the venue's casual tone, not slip into marketing copy or scripted responses. Tests brevity. Tested across `new`, `returning`, and `regular` because familiarity tone scales with relationship strength.
- **target_count**: 1
- **guest_states**: `['new', 'returning', 'regular']`
- **example_phrasings**:
  - "how's your day going?"
  - "busy day?"
  - "weather's wild today"

### Category 14: gratitude

- **description**: Guest expresses thanks. Tests brevity discipline — should not over-respond with "you're so welcome, thanks for being a great guest" type copy. Tests tone match.
- **target_count**: 1
- **guest_states**: `['any']`
- **example_phrasings**:
  - "thanks!"
  - "appreciate it"
  - "you're the best"

### Category 15: event / mechanic-specific

- **description**: Guest asks about a venue event, workshop, open mic, or scheduled mechanic. Tests **R2** (when phrased "is the workshop tonight" or "what time is open mic"). Currently the mechanics flow doesn't reliably surface event-specific responses — these rows produce `verdict=edit` until that infrastructure matures.
- **target_count**: 2
- **guest_states**: `['any']`
- **expected_failure**: `mechanics_flow_immature`
- **example_phrasings**:
  - "when's the next open mic?"
  - "is the workshop full?"
  - "any events this weekend?"

### Category 16: goodbye / sign-off

- **description**: Guest signs off the conversation. Tests brevity. Tests register match — no forced cheerfulness.
- **target_count**: 1
- **guest_states**: `['any']`
- **example_phrasings**:
  - "see you tomorrow"
  - "later"
  - "have a good one"

### Category 17: out of scope

- **description**: Guest asks something outside the venue's scope. Tests scope discipline — agent declines or redirects without overreaching. Tests **R5** (don't redirect blindly to "Google it" — there's a difference between "outside our scope" and "I won't help"). Includes both clearly out-of-scope cases and venue-adjacent cases (where the agent might be tempted to help).
- **target_count**: 3
- **guest_states**: `['any']`
- **example_phrasings**:
  - "what's the weather like today?"
  - "can you recommend another cafe nearby?"
  - "what's a good restaurant for dinner?"
  - "tell me a joke"