#!/usr/bin/env node
// Rewrite data/puzzlePool.en.json in-place so every title is the canonical
// form returned by resolveRedirect() (follows Wikipedia redirects).
//
// Side effects handled (same as fixZhPool.js):
//   - Pairs collapsing to duplicate (origin, destination) → keep first.
//   - Triples where targets merge into the same title → drop entirely
//     (need 3 distinct per game rules).
//
// Writes a .bak alongside the original.
//
// Usage:
//   node scripts/fixEnPool.js          # apply fix
//   node scripts/fixEnPool.js --dry    # show what would change, don't write

const fs = require('fs');
const path = require('path');
const { resolveRedirect, normalizeArticle } = require('..' + path.sep + 'server.js');

const DRY = process.argv.includes('--dry');
const POOL_PATH = path.join(__dirname, '..', 'data', 'puzzlePool.en.json');
const BAK_PATH = POOL_PATH + '.bak';

async function main() {
  const raw = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const pairs = raw.pairs || [];
  const triples = raw.triples || [];

  const titles = new Set();
  for (const p of pairs)   { titles.add(p.origin); titles.add(p.destination); }
  for (const t of triples) { for (const x of t.targets) titles.add(x); }

  console.log(`Resolving ${titles.size} unique titles → canonical form...`);
  const replace = new Map();
  let checked = 0;
  for (const title of titles) {
    checked++;
    process.stdout.write(`\r  [${checked}/${titles.size}]`);
    try {
      const canonical = await resolveRedirect(title, 'en');
      if (canonical && normalizeArticle(canonical) !== normalizeArticle(title)) {
        replace.set(title, canonical);
      }
    } catch (e) {
      // Leave untouched on error.
    }
  }
  process.stdout.write('\n\n');

  if (replace.size === 0) {
    console.log('✓ All titles already canonical. No changes.');
    return;
  }
  console.log(`Applying ${replace.size} title replacements:`);
  for (const [from, to] of replace) console.log(`  ${from}  →  ${to}`);
  console.log();

  const seenPairs = new Set();
  const newPairs = [];
  let droppedDupPairs = 0;
  for (const p of pairs) {
    const origin = replace.get(p.origin) || p.origin;
    const destination = replace.get(p.destination) || p.destination;
    const key = `${normalizeArticle(origin)}→${normalizeArticle(destination)}`;
    if (seenPairs.has(key)) { droppedDupPairs++; continue; }
    seenPairs.add(key);
    newPairs.push({ ...p, origin, destination });
  }

  const seenTriples = new Set();
  const newTriples = [];
  let droppedDupTriples = 0;
  let droppedCollapsedTriples = 0;
  for (const t of triples) {
    const targets = t.targets.map(x => replace.get(x) || x);
    const distinct = new Set(targets.map(normalizeArticle));
    if (distinct.size !== targets.length) { droppedCollapsedTriples++; continue; }
    const key = [...distinct].sort().join('|');
    if (seenTriples.has(key)) { droppedDupTriples++; continue; }
    seenTriples.add(key);
    newTriples.push({ ...t, targets });
  }

  const newPool = { ...raw, pairs: newPairs, triples: newTriples };
  newPool.generatedAt = new Date().toISOString();

  console.log(`Result:`);
  console.log(`  pairs:   ${pairs.length} → ${newPairs.length}  (dropped ${droppedDupPairs} dup)`);
  console.log(`  triples: ${triples.length} → ${newTriples.length}  (dropped ${droppedDupTriples} dup + ${droppedCollapsedTriples} collapsed)`);

  if (DRY) {
    console.log('\n(--dry) Not writing. Re-run without --dry to apply.');
    return;
  }

  fs.copyFileSync(POOL_PATH, BAK_PATH);
  fs.writeFileSync(POOL_PATH, JSON.stringify(newPool, null, 2));
  console.log(`\n✓ Wrote ${POOL_PATH}`);
  console.log(`  Backup at ${BAK_PATH}`);
}

main().catch(e => { console.error('Fix failed:', e); process.exit(1); });
