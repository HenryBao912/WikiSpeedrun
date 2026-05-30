#!/usr/bin/env node
// Tests for the backlink-count guardrail + daily-challenge sparseness fixes
// (Bugs 1 & 2). No test framework in this repo, so this is a plain assert
// script: exits non-zero on failure. Run: node scripts/testBacklinks.js
//
//   1. countBacklinks("Apple_Inc.") returns a HIGH count (was 0 before the fix).
//   2. A genuinely-sparse article is detected as sparse.
//   3. zh Simplified titles resolve to their canonical form (were counted as 0).
//   4. The daily-challenge selector never returns a sparse / blacklisted dest.

const path = require('path');
const fs = require('fs');
const wss = require('..' + path.sep + 'server.js');

let failures = 0;
function ok(cond, msg) { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failures++; }

(async () => {
  console.log('\nBacklink + daily-sparseness tests\n');

  console.log('[1] countBacklinks returns a high count for major articles (Bug 1)');
  const apple = await wss.countBacklinks('Apple_Inc.', 100, 'en');
  ok(apple !== null && apple >= 100, `Apple_Inc. → ${apple} (expected ≥100)`);
  const leo = await wss.countBacklinks('Leonardo_DiCaprio', 100, 'en');
  ok(leo !== null && leo >= 100, `Leonardo_DiCaprio → ${leo} (expected ≥100)`);

  console.log('\n[2] genuinely-sparse articles are detected (threshold 15)');
  const rain = await wss.countBacklinks('Raindrop_cake', 15, 'en');
  ok(rain !== null && rain < 15, `Raindrop_cake → ${rain} (expected <15)`);

  console.log('\n[3] zh Simplified titles resolve to canonical (Bug found: variant counting)');
  const ko = await wss.countBacklinks('柯震东', 15, 'zh'); // Simplified; page is Traditional 柯震東
  ok(ko !== null && ko >= 15, `柯震东 → ${ko} (expected ≥15, was 0 before converttitles fix)`);

  console.log('\n[4] daily-challenge selector never returns a sparse/blacklisted destination (Bug 2)');
  // Deterministic: the daily draws from the (now-cleaned) pool. Walk 120 days
  // and assert each destination is a real pool destination and not blacklisted.
  const poolDests = new Set();
  for (const lang of ['en']) {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', `puzzlePool.${lang}.json`), 'utf8'));
    p.pairs.forEach(x => poolDests.add(x.destination));
  }
  let badDaily = 0, checked = 0;
  const start = Date.parse('2026-05-12T00:00:00Z');
  for (let i = 0; i < 120; i++) {
    const d = new Date(start + i * 24 * 60 * 60 * 1000);
    const daily = wss.getDailyChallenge(d);
    if (!daily) continue;
    checked++;
    if (wss.HARDCODED_DAILY_BLACKLIST.has(daily.destination)) { console.log(`    blacklisted dest on ${daily.date}: ${daily.destination}`); badDaily++; }
    if (!poolDests.has(daily.destination)) { console.log(`    non-pool dest on ${daily.date}: ${daily.destination}`); badDaily++; }
  }
  ok(badDaily === 0, `${checked} daily puzzles checked, ${badDaily} bad (blacklisted/non-pool)`);
  // The known incident articles must be gone from the pool entirely.
  for (const bad of ['1win', 'Raindrop_cake', 'Suicide_methods']) {
    ok(!poolDests.has(bad), `pool no longer contains "${bad}"`);
  }

  console.log('\n' + (failures ? `✗ ${failures} test(s) FAILED` : '✓ all tests passed') + '\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
