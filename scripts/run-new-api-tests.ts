// Drive the api-tester suite, scoped to just the new round-trip + validation
// tests, against the live inventory. Used to verify the suite changes work.

import { runApiTests } from '../src/lib/apiTester';
import { loadInventory } from '../src/lib/inventory';

const TARGET_IDS = new Set([
  'testcases-import-delete',
  'testcases-roundtrip-rename',
  'testcases-import-empty-name',
  'testcases-import-empty-id',
  'testcases-import-whitespace-name',
  'testcases-import-xss-name',
  'testcases-import-missing-name-error',
  'testcases-import-collision-status',
]);

async function main() {
  const inv = loadInventory();
  const r = await runApiTests(inv, {
    categories: ['mutating', 'testcases'],
    includeDestructive: true,
    includeLongRunning: true,
    includeNegative: false,
  });
  const filtered = r.results.filter((x) => TARGET_IDS.has(x.id));
  console.log(`\n=== ${filtered.length} target tests ===\n`);
  for (const t of filtered) {
    const tag = t.skipped ? 'SKIP' : (t.ok ? 'PASS' : 'FAIL');
    console.log(`[${tag}] ${t.id}`);
    console.log(`       ${t.name}`);
    if (t.skipped) {
      console.log(`       reason: ${t.skippedReason}`);
    } else {
      console.log(`       status: ${t.status}  detail: ${t.detail}`);
      if (!t.ok && t.expected) console.log(`       expected: ${t.expected}`);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
