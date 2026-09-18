#!/usr/bin/env node
/**
 * run-report.mjs — what the build workflow posts when its session runs into
 * the turn limit (TAC-447).
 *
 *   node scripts/run-report.mjs ending <execution-file> <max-turns>
 *   node scripts/run-report.mjs notice <ticket> <execution-file> <max-turns>
 *
 * Run by the workflow's check step after the session, never by the session.
 * All the logic is in lib/run-report.mjs, which the tests import. This file
 * only wires it to the process. Uses nothing outside Node's standard library.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { run } from './lib/run-report.mjs';

process.exitCode = run({
  argv: process.argv.slice(2),
  env: process.env,
  readFile: (path) => readFileSync(path, 'utf8'),
  git: (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
