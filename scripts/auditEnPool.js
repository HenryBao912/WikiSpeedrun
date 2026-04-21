#!/usr/bin/env node
// Read-only audit of data/puzzlePool.en.json: checks every title via
// resolveRedirect() — if Wikipedia returns a different canonical title, the
// stored title is a stale redirect (e.g., pool has "Obama" but canonical is
// "Barack_Obama"). Also flags namespace-prefixed titles (Talk:, Category:,
// etc.) which shouldn't be in the gameplay pool.
//
// Reports only — does NOT mutate the pool file.

const fs = require('fs');
const path = require('path');
const { resolveRedirect, normalizeArticle } = require('..' + path.sep + 'server.js');

const POOL_PATH = path.join(__dirname, '..', 'data', 'puzzlePool.en.json');

// Namespaces that shouldn't appear in the gameplay pool.
const BAD_NAMESPACES = /^(Talk|User|Wikipedia|File|MediaWiki|Template|Help|Category|Portal|Draft|TimedText|Module|Special):/;

async function main() {
  const raw = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const titles = new Set();
  for (const p of raw.pairs || [])   { titles.add(p.origin); titles.add(p.destination); }
  for (const t of raw.triples || []) { for (const x of t.targets) titles.add(x); }

  const all = [...titles];
  console.log(`Auditing ${all.length} unique titles in data/puzzlePool.en.json`);
  console.log('(resolveRedirect on each — takes ~1 min)\n');

  const redirects = [];
  const namespaced = [];
  const errors = [];
  let checked = 0;
  for (const title of all) {
    checked++;
    process.stdout.write(`\r  [${checked}/${all.length}] ${title.slice(0, 40).padEnd(40)}`);

    if (BAD_NAMESPACES.test(title)) namespaced.push(title);

    try {
      const canonical = await resolveRedirect(title, 'en');
      if (canonical && normalizeArticle(canonical) !== normalizeArticle(title)) {
        redirects.push({ stored: title, canonical });
      }
    } catch (e) {
      errors.push({ title, err: e.message });
    }
  }
  process.stdout.write('\n\n');

  let problems = 0;
  if (redirects.length === 0) {
    console.log(`✓ All ${all.length} titles are canonical (no stale redirects).`);
  } else {
    problems += redirects.length;
    console.log(`✗ Found ${redirects.length} titles that are stale redirects:\n`);
    for (const { stored, canonical } of redirects) {
      console.log(`  ${stored}  →  ${canonical}`);
    }
    console.log();
  }
  if (namespaced.length === 0) {
    console.log(`✓ No namespace-prefixed titles.`);
  } else {
    problems += namespaced.length;
    console.log(`✗ Found ${namespaced.length} namespace-prefixed titles (should not be in pool):`);
    for (const t of namespaced) console.log(`  ${t}`);
    console.log();
  }
  if (errors.length > 0) {
    console.log(`⚠ ${errors.length} titles errored during check:`);
    for (const { title, err } of errors.slice(0, 10)) console.log(`  ${title}: ${err}`);
    if (errors.length > 10) console.log(`  ...and ${errors.length - 10} more`);
  }

  process.exit(problems === 0 ? 0 : 1);
}

main().catch(e => { console.error('Audit failed:', e); process.exit(2); });
