#!/usr/bin/env node
/**
 * reconcile-needs-decision.mjs — the build workflow's per-run derivation of
 * whether Needs Decision should be on a ticket, from its comment thread
 * (TAC-446).
 *
 *   node scripts/reconcile-needs-decision.mjs < candidates.json
 *
 * Run by the workflow's "Find tickets to work" step, never by a session. All
 * the logic is in lib/reconcile-needs-decision.mjs, which the tests import.
 * This file only wires it to the process. Unlike scripts/reconcile-status.mjs
 * it needs no git or gh call — every input is already in the same Linear
 * query the workflow already ran — so it touches only stdin and stdout. Uses
 * nothing outside Node's standard library.
 */

import { readFileSync } from 'node:fs';
import { run } from './lib/reconcile-needs-decision.mjs';

process.exitCode = run({
  stdin: readFileSync(0, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
