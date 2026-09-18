#!/usr/bin/env node
/**
 * refresh-branch.mjs — the build workflow's pre-session repair of a resumed
 * ticket's branch, when it predates the Linear write helper (TAC-462).
 *
 *   node scripts/refresh-branch.mjs < tickets.json
 *
 * Run by the workflow's "Find tickets to work" step, never by a session. All
 * the logic is in lib/refresh-branch.mjs, which the tests import. This file
 * only wires it to the process and to `git`/`gh`. Uses nothing outside
 * Node's standard library.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { run } from './lib/refresh-branch.mjs';

const exec = (command) => (args) => {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output };
  } catch (err) {
    // The [STALE-BRANCH] notice needs the real failure text, not just
    // success/failure — see lib/refresh-branch.mjs's header.
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim() || err.message;
    return { ok: false, output };
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
