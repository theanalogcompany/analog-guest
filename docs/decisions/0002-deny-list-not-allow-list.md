# 0002 - A set keyed on a closed vocabulary is a deny-list

**Date:** 2026-09-23 (generalised 2026-09-28)
**Status:** accepted

## Decision

When code decides behaviour from a closed vocabulary - an approval trigger, a venue status, a
message category - express it as a **deny-list over a total map**, never an allow-list of the
values you expect.

Two layers, both required:

1. A **total** `satisfies Record<K, V>` map, so a new member fails `tsc` until someone decides
   what it does.
2. A **runtime** parse that degrades an unrecognised value to the **permissive** side and
   warns.

`readonly K[]` is not a substitute for layer 1: it checks each element is a `K` and cannot
check the list is complete.

## Why

This repo has paid for the allow-list version twice.

**`shouldSendDraftFlaggedPush`** derived its fire-set from `Object.keys()` of a label map that
did two jobs. Two triggers shipped afterwards, fell outside the set, and **no APNs request was
attempted for two months** while 121 tests stayed green - one of which asserted the broken
behaviour under the name `returns false for unknown triggers (future-add safety)`.

**`venues.status`** was about to get an allow-list admitting `active`, which reads as the
obvious implementation. Production is inverted relative to any natural reading: the only live
pilot venue is `pending` and both mock venues are `active`. That allow-list **would have
switched the pilot venue off on the day it merged.**

The general shape: an allow-list encodes the values you happened to know about, and the cost
lands later, silently, on whoever adds the next one. A deny-list encodes only what you have
positively decided to exclude.

The permissive default on the runtime parse follows the same reasoning. For a push, a
dismissible notification beats a queued draft nobody was told about. For a venue, processing an
unrecognised status beats silently switching a venue off.

## What breaks if reversed

An allow-list drops every value added after it was written, with no error and no test failure,
because the dropped value is by definition one nothing asserts on. The two recorded instances
went unnoticed for two months and would have taken a live venue offline.

## Where it lives

`lib/notifications/push-policy.ts` (`PUSH_POLICY`, and the separate label map that must stay
separate) · `lib/venues/status.ts` (`VENUE_PROCESSING`) · `lib/agent/stages.ts`
(`APPROVAL_TRIGGERS`) · `lib/ai/types.ts` (`MESSAGE_CATEGORIES`).
