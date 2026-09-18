#!/usr/bin/env node
/**
 * linear.mjs — how a CI Claude Code session writes to Linear (TAC-444).
 *
 *   node scripts/linear.mjs comment  <issue> <file.md>
 *   node scripts/linear.mjs describe <issue> <file.md>
 *   node scripts/linear.mjs label add|remove <issue> "<label name>"
 *   node scripts/linear.mjs state <issue> "<state name>"
 *
 * The text of a comment or description comes from a plain markdown file,
 * written with the Write tool, so nothing has to be JSON-escaped by hand.
 * Ids are looked up here, comments are posted flat, and the exit code is 0
 * only when Linear answers success: true.
 *
 * Env: LINEAR_API_KEY. Read here and never printed.
 *
 * All the logic is in lib/linear-cli.mjs, which the tests import. This file
 * only wires it to the process. Uses nothing outside Node's standard library,
 * because the audit workflow runs it without installing dependencies.
 */

import { readFile } from 'node:fs/promises';
import { run } from './lib/linear-cli.mjs';

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: globalThis.fetch,
  readFile: (path) => readFile(path, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
