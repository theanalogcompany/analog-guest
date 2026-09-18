#!/usr/bin/env node
/**
 * claims.mjs — the build workflow's check that no other session has a
 * ticket before it takes one (TAC-448).
 *
 *   node scripts/claims.mjs < candidates.json
 *
 * Run by the workflow's "Find tickets to work" step, never by a session. All
 * the logic is in lib/claims.mjs, which the tests import. This file only
 * wires it to the process. Uses nothing outside Node's standard library.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { run } from './lib/claims.mjs';

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
  now: Date.now(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
