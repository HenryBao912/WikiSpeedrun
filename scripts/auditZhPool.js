#!/usr/bin/env node
// Read-only audit of data/puzzlePool.zh.json: checks every title via
// toVariantTitle() (which queries MediaWiki with variant=zh-cn). If the
// returned Simplified form differs from what's stored, the stored form was
// Traditional (or a mixed-script variant). Reports findings only — does NOT
// mutate the pool file.

const fs = require('fs');
const path = require('path');
const { toVariantTitle } = require('..' + path.sep + 'server.js');

const POOL_PATH = path.join(__dirname, '..', 'data', 'puzzlePool.zh.json');

async function main() {
  const raw = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const titles = new Set();
  for (const p of raw.pairs || [])   { titles.add(p.origin); titles.add(p.destination); }
  for (const t of raw.triples || []) { for (const x of t.targets) titles.add(x); }

  const all = [...titles];
  console.log(`Auditing ${all.length} unique titles in data/puzzlePool.zh.json`);
  console.log('(querying each via toVariantTitle — this takes a minute)\n');

  const mismatches = [];
  const errors = [];
  let checked = 0;
  // Serial to respect wikiAPI's rate-limit semaphore. ~350 titles × ~200ms = ~70s.
  for (const title of all) {
    checked++;
    process.stdout.write(`\r  [${checked}/${all.length}] ${title.slice(0, 30).padEnd(30)}`);
    try {
      const canonical = await toVariantTitle(title, 'zh');
      if (canonical && canonical !== title) {
        mismatches.push({ stored: title, simplified: canonical });
      }
    } catch (e) {
      errors.push({ title, err: e.message });
    }
  }
  process.stdout.write('\n\n');

  if (mismatches.length === 0) {
    console.log(`✓ All ${all.length} titles are Simplified.`);
  } else {
    console.log(`✗ Found ${mismatches.length} titles that are NOT fully Simplified:\n`);
    for (const { stored, simplified } of mismatches) {
      console.log(`  ${stored}  →  ${simplified}`);
    }
  }
  if (errors.length > 0) {
    console.log(`\n⚠ ${errors.length} titles errored during check:`);
    for (const { title, err } of errors.slice(0, 10)) console.log(`  ${title}: ${err}`);
    if (errors.length > 10) console.log(`  ...and ${errors.length - 10} more`);
  }

  // Exit non-zero if mismatches found, so this is CI-friendly.
  process.exit(mismatches.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('Audit failed:', e); process.exit(2); });
