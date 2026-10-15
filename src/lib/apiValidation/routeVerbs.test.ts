import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

/**
 * Both verbs must live in the one route file.
 *
 * Next routes by path, not by verb. Adding DELETE as a new file at
 * runs/[id]/route.ts replaced the GET the page polls for live progress, so a
 * run sat at "running · 0/86" with its results already on the server until
 * someone reloaded. Nothing in the type system or the build catches that —
 * the file simply has fewer exports than it used to.
 */
test('runs/[id] serves both GET and DELETE', () => {
  const src = fs.readFileSync('src/app/api/api-validation/runs/[id]/route.ts', 'utf8');
  assert.match(src, /export async function GET\b/, 'the live-progress poll needs GET');
  assert.match(src, /export async function DELETE\b/, 'deleting a report needs DELETE');
});
