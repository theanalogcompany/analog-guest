#!/usr/bin/env node
/**
 * turn-limit-restart.mjs — whether the build workflow resumes a
 * turn-limited ticket automatically, without a human reply (TAC-480).
 *
 *   node scripts/turn-limit-restart.mjs < candidates.json
 *
 * Run by the workflow's "Find tickets to work" step, before scripts/claims.mjs,
 * never by a session. All the logic is in lib/turn-limit-restart.mjs, which
 * the tests import. This file only wires it to the process. Uses nothing
 * outside Node's standard library.
 */

import { readFileSync } from 'node:fs';
import { run } from './lib/turn-limit-restart.mjs';

process.exitCode = run({
  env: process.env,
  stdin: readFileSync(0, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
