#!/usr/bin/env node
// Regression tests for the Wikipedia API layer — run: node scripts/testWikiApi.js
// Hits the LIVE en.wikipedia API (needs network; ~30s). Guards the two prod
// incidents we shipped fixes for:
//
//   1. Backlink cache poisoning (Jun 2026): HTTP-200 {"error":...} bodies were
//      parsed as success, so countBacklinks computed 0 for mega-popular pages
//      (Apple_Inc., Leonardo_DiCaprio) and cached the 0 for 7 days — every
//      game start with that destination got falsely rejected as sparse.
//
//   2. illegal_move false positives (Jul 2026): the player's position was
//      stored as the RAW clicked title; when that title was a redirect
//      ([[Rooster]] → Chicken), prop=links returned the redirect stub's
//      single link and every click on the rendered article was rejected
//      (~2,585/week in prod logs).
//
// These call server.js internals via a patched require (module.exports
// doesn't expose isLegalMove), so the test re-exports what it needs.

const fs = require('fs');
const path = require('path');

// Patch-export internals the test needs but server.js doesn't export.
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const patched = src.replace(/^module\.exports = \{/m, 'module.exports = {\n  isLegalMove, wikiAPI, linkCache, cacheSet, cacheKey,');
const tmp = path.join(__dirname, '..', '_testWikiApi_patched.cjs');
fs.writeFileSync(tmp, patched);
const s = require(tmp);

let pass = 0, fail = 0;
const ok = (label, cond) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label);
  cond ? pass++ : fail++;
};

(async () => {
  try {
    console.log('── Backlink counting (poisoning regression) ──');
    // The user-visible bar from the incident report: Apple_Inc. must count
    // well past the sparse threshold. getBacklinks with a high limit proves
    // the pagination + parsing path; countBacklinks proves the guardrail path.
    const apple = await s.getBacklinks('Apple_Inc.', 120);
    ok(`getBacklinks('Apple_Inc.', 120).size > 100 (got ${apple.size})`, apple.size > 100);
    ok('countBacklinks(Apple_Inc.) hits threshold', (await s.countBacklinks('Apple_Inc.', 15)) >= 15);
    ok('countBacklinks(Meet_the_Parents) hits threshold', (await s.countBacklinks('Meet_the_Parents', 15)) >= 15);
    ok('countBacklinks(Leonardo_DiCaprio) hits threshold', (await s.countBacklinks('Leonardo_DiCaprio', 15)) >= 15);

    console.log('── Genuinely sparse / invalid destinations still rejected ──');
    const burger = await s.countBacklinks('Burger', 15);
    ok(`Burger is truly sparse — links target Hamburger (got ${burger})`, burger !== null && burger < 15);
    ok('MediaWiki-invalid title "../foo" → definitive 0, not fail-open', (await s.countBacklinks('../foo', 15)) === 0);

    console.log('── HTTP-200 error bodies reject (the poisoning vector) ──');
    let code = null;
    const t0 = Date.now();
    try {
      await s.wikiAPI({ action: 'query', list: 'backlinks', bltitle: '../foo', bllimit: '15', blnamespace: '0' });
    } catch (e) { code = e.apiCode; }
    ok(`error body rejects with apiCode (got ${code})`, code === 'invalidtitle');
    ok(`deterministic errors fail fast, no retry backoff (${Date.now() - t0}ms)`, Date.now() - t0 < 600);

    console.log('── isLegalMove redirect resolution (false-rejection regression) ──');
    ok('Rooster → Poultry legal (link lives on Chicken)', await s.isLegalMove('Rooster', 'Poultry'));
    ok('Rooster → Chicken legal (redirect target itself)', await s.isLegalMove('Rooster', 'Chicken'));
    ok('Rooster → Quantum_field_theory still REJECTED', !(await s.isLegalMove('Rooster', 'Quantum_field_theory')));

    console.log('── Poisoned-cache rescue (Jul 12–13 incident: room 269BF) ──');
    // A rate-limit storm cached a truncated/junk link set as complete; every
    // click from that position was rejected for up to 24h. The pltitles probe
    // must rescue real links and still confirm-reject fabricated moves.
    s.cacheSet(s.linkCache, s.cacheKey('en', '2014_FIFA_World_Cup'), new Set(['junk entry']));
    ok('poisoned cache: real link rescued by probe', await s.isLegalMove('2014_FIFA_World_Cup', 'Brazil'));
    ok('poisoned cache: fabricated move still REJECTED', !(await s.isLegalMove('2014_FIFA_World_Cup', 'Taylor_Swift')));
  } finally {
    fs.unlinkSync(tmp);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { fs.unlinkSync(tmp); } catch (_) {} process.exit(2); });
