#!/usr/bin/env node
/**
 * reconcile-status.mjs — the build workflow's per-run write of a ticket's
 * status from public GitHub state (TAC-466).
 *
 *   node scripts/reconcile-status.mjs < candidates.json
 *
 * Run by the workflow's "Find tickets to work" step, never by a session. All
 * the logic is in lib/reconcile-status.mjs, which the tests import. This
 * file only wires it to the process. Uses nothing outside Node's standard
 * library.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { run } from './lib/reconcile-status.mjs';

const exec = (command) => (args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

process.exitCode = run({
  env: process.env,
  stdin: readFileSync(0, 'utf8'),
  git: exec('git'),
  gh: exec('gh'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
