#!/usr/bin/env python3
"""Mutation pass for the scan-greeting harness. See README.md.

Breaks the source one way at a time, runs harness.ts, and reports whether a
check failed. Every mutant should be KILLED. A SURVIVED mutant is a behaviour
the harness does not check; an INVALID one proved nothing either way.

Each file is restored from a byte copy taken before the edit, never from git,
so it is safe to run on uncommitted work.
"""

import os
import re
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
HARNESS = os.path.join("scripts", "harness", "scan-greeting", "harness.ts")
STORE = "lib/agent/scan-arrival-store.ts"
TIMING = "lib/agent/scan-arrival.ts"
PROCESSOR = "lib/agent/instagram-scan-greeting.ts"

SLEEP = (
    "    await deps.sleep(\n"
    "      msUntilScanGreetingDue(scheduled.scannedAt, deps.now()) +\n"
    "        SCAN_FAST_PATH_WAKE_MARGIN_MS,\n"
    "    )\n"
)

# (name, file, exact text that must match ONCE, replacement)
MUTANTS = [
    (
        "claim without claimed_at IS NULL",
        STORE,
        "    .is('claimed_at', null)\n    .is('resolved_at', null)\n    .select('id')\n  if (error) {\n    if (error.code === UNIQUE_VIOLATION)",
        "    .is('resolved_at', null)\n    .select('id')\n  if (error) {\n    if (error.code === UNIQUE_VIOLATION)",
    ),
    (
        "claim without resolved_at IS NULL",
        STORE,
        "    .is('claimed_at', null)\n    .is('resolved_at', null)\n    .select('id')\n  if (error) {\n    if (error.code === UNIQUE_VIOLATION)",
        "    .is('claimed_at', null)\n    .select('id')\n  if (error) {\n    if (error.code === UNIQUE_VIOLATION)",
    ),
    (
        "23505 branch deleted",
        STORE,
        "    if (error.code === UNIQUE_VIOLATION)\n      return { status: 'already_greeted_today' }\n",
        "",
    ),
    (
        "unclaimed resolve without resolved_at IS NULL",
        STORE,
        "update.is('claimed_at', null).is('resolved_at', null)",
        "update.is('claimed_at', null)",
    ),
    (
        "unclaimed resolve without claimed_at IS NULL",
        STORE,
        "update.is('claimed_at', null).is('resolved_at', null)",
        "update.is('resolved_at', null)",
    ),
    (
        "fast path judges at the pre-sleep instant",
        PROCESSOR,
        "  try {\n" + SLEEP,
        "  const stale = deps.now()\n  deps = { ...deps, now: () => stale }\n  try {\n" + SLEEP,
    ),
    (
        "fast path guard does not cover the sleep",
        PROCESSOR,
        "  try {\n" + SLEEP,
        "  await deps.sleep(0)\n  try {\n" + SLEEP,
    ),
    (
        "inbound re-check skipped",
        PROCESSOR,
        "    if (await guestWroteSince(supabase, row)) {",
        "    if (false && (await guestWroteSince(supabase, row))) {",
    ),
    (
        "no wake margin",
        TIMING,
        "export const SCAN_FAST_PATH_WAKE_MARGIN_MS = 250",
        "export const SCAN_FAST_PATH_WAKE_MARGIN_MS = 0",
    ),
    (
        "sleep uncapped",
        TIMING,
        "  return Math.min(Math.max(remaining, 0), 2 * delayMs)",
        "  return Math.max(remaining, 0)",
    ),
    (
        "carry-forward re-derived from the delay",
        TIMING,
        "export const SCAN_CARRY_FORWARD_MS = 5 * 60 * 1000",
        "export const SCAN_CARRY_FORWARD_MS = SCAN_GREETING_DELAY_MS",
    ),
    (
        "delay back to five minutes",
        TIMING,
        "export const SCAN_GREETING_DELAY_MS = 20 * 1000",
        "export const SCAN_GREETING_DELAY_MS = 5 * 60 * 1000",
    ),
]

# No credentials reach the harness: it refuses to run with them, and this is
# what guarantees a mutant cannot send anything either.
ENV = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}


def run_harness():
    """Returns (checks collected, names of failed checks)."""
    done = subprocess.run(
        ["npx", "tsx", HARNESS],
        cwd=REPO,
        env=ENV,
        capture_output=True,
        text=True,
        timeout=300,
    )
    out = done.stdout.splitlines()
    collected = sum(1 for line in out if re.match(r"^(ok  |FAIL) ", line))
    failed = [line[5:] for line in out if line.startswith("FAIL ")]
    return collected, failed


def main():
    baseline, failed = run_harness()
    if baseline == 0 or failed:
        print(f"unmutated harness is not clean ({baseline} checks, {len(failed)} failed); fix that first")
        return 2
    print(f"baseline: {baseline} checks pass\n")

    not_killed = 0
    for name, rel, old, new in MUTANTS:
        path = os.path.join(REPO, rel)
        with open(path, "rb") as handle:
            original = handle.read()
        text = original.decode()
        # A mutant is only evidence if the intended text changed, exactly once.
        if text.count(old) != 1:
            print(f"INVALID   {name}: anchor matched {text.count(old)} times in {rel}")
            not_killed += 1
            continue
        try:
            with open(path, "w") as handle:
                handle.write(text.replace(old, new))
            collected, failed = run_harness()
        finally:
            with open(path, "wb") as handle:
                handle.write(original)
        # A file that stopped compiling collects nothing and fails nothing,
        # which would read as a survivor. Require the full set.
        if collected != baseline:
            print(f"INVALID   {name}: collected {collected} of {baseline} checks")
            not_killed += 1
        elif failed:
            print(f"KILLED    {name}")
            for check in failed:
                print(f"            by: {check}")
        else:
            print(f"SURVIVED  {name}")
            not_killed += 1

    print(f"\n{len(MUTANTS) - not_killed} of {len(MUTANTS)} mutants killed")
    return 1 if not_killed else 0


if __name__ == "__main__":
    sys.exit(main())
