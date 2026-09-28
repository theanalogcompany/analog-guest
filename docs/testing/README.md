<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# What the test suite covers

305 test files, 5952 `it`/`test` declaration sites, across 26 areas.

**Declaration sites are not the test count.** `.each` tables expand at runtime, so the
figure `vitest` reports is higher. Quote the run, never this number - the root `CLAUDE.md`
records the measured baseline and how to re-measure it.

The `headers` column is how many of an area's test files open with a comment block
describing what they pin. A low ratio means that area's summaries below are mostly derived
from `describe` names, which are less reliable.

| area | files | cases | headers | detail |
| --- | --- | --- | --- | --- |
| `<root>` | 1 | 7 | 0/1 | [root.md](root.md) |
| `app/admin` | 51 | 474 | 11/51 | [app-admin.md](app-admin.md) |
| `app/api` | 26 | 271 | 20/26 | [app-api.md](app-api.md) |
| `lib/agent` | 42 | 1539 | 15/42 | [lib-agent.md](lib-agent.md) |
| `lib/ai` | 18 | 911 | 1/18 | [lib-ai.md](lib-ai.md) |
| `lib/analytics` | 2 | 19 | 0/2 | [lib-analytics.md](lib-analytics.md) |
| `lib/auth` | 7 | 72 | 1/7 | [lib-auth.md](lib-auth.md) |
| `lib/followups` | 3 | 94 | 2/3 | [lib-followups.md](lib-followups.md) |
| `lib/guests` | 5 | 209 | 3/5 | [lib-guests.md](lib-guests.md) |
| `lib/messaging` | 28 | 396 | 18/28 | [lib-messaging.md](lib-messaging.md) |
| `lib/notifications` | 7 | 122 | 2/7 | [lib-notifications.md](lib-notifications.md) |
| `lib/observability` | 1 | 23 | 0/1 | [lib-observability.md](lib-observability.md) |
| `lib/operator` | 11 | 231 | 8/11 | [lib-operator.md](lib-operator.md) |
| `lib/pos` | 12 | 70 | 4/12 | [lib-pos.md](lib-pos.md) |
| `lib/rag` | 1 | 12 | 0/1 | [lib-rag.md](lib-rag.md) |
| `lib/recognition` | 5 | 33 | 0/5 | [lib-recognition.md](lib-recognition.md) |
| `lib/schemas` | 17 | 298 | 3/17 | [lib-schemas.md](lib-schemas.md) |
| `lib/tunables` | 1 | 8 | 0/1 | [lib-tunables.md](lib-tunables.md) |
| `lib/ui` | 1 | 4 | 0/1 | [lib-ui.md](lib-ui.md) |
| `lib/venues` | 1 | 14 | 0/1 | [lib-venues.md](lib-venues.md) |
| `lib/voice-training` | 6 | 38 | 6/6 | [lib-voice-training.md](lib-voice-training.md) |
| `lib/voices` | 6 | 61 | 3/6 | [lib-voices.md](lib-voices.md) |
| `scripts` | 2 | 81 | 0/2 | [scripts.md](scripts.md) |
| `scripts/lib` | 16 | 446 | 0/16 | [scripts-lib.md](scripts-lib.md) |
| `scripts/measurement` | 10 | 170 | 0/10 | [scripts-measurement.md](scripts-measurement.md) |
| `scripts/onboarding` | 25 | 349 | 3/25 | [scripts-onboarding.md](scripts-onboarding.md) |

## What is not here

- **No rendered-component tests.** There is no `.test.tsx` in the repo, so the Command
  Center UI is verified by eye and by its loaders, never by rendering.
- **No end-to-end tier in `vitest`.** `scripts/measurement/*` make real model calls, cost
  money, and are run by hand. `npm run run-test-scenarios` must run during a venue's open
  hours. CI runs none of them.
- **DB-touching code is generally not unit-tested**, by the convention in the root
  `CLAUDE.md`, and neither is the non-`-pure.ts` half of a module split. A source file with
  no sibling test is often deliberate; it is not a gap by itself.
