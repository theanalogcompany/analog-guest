#!/usr/bin/env node
/**
 * pending-question.mjs — the build workflow's check for a candidate whose
 * blocking label was cleared without an answer (TAC-453).
 *
 *   node scripts/pending-question.mjs < candidates.json
 *
 * Run by the workflow's "Find tickets to work" step, never by a session. All
 * the logic is in lib/pending-question.mjs, which the tests import. This
 * file only wires it to the process — it needs no git or gh, since
 * everything it reads is the comment thread already fetched from Linear.
 * Uses nothing outside Node's standard library.
 */

import { readFileSync } from 'node:fs';
import { run } from './lib/pending-question.mjs';

process.exitCode = run({
  stdin: readFileSync(0, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
