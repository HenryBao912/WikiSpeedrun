#!/usr/bin/env node
// Rewrite data/puzzlePool.zh.json in-place so every title is the Simplified
// canonical returned by toVariantTitle (which uses MediaWiki action=parse with
// variant=zh-cn + redirects=1).
//
// Side effects handled:
//   - Pairs whose (origin, destination) collapse to a duplicate key after
//     conversion → keep the first occurrence.
//   - Triples where two or more targets merge into the same title → drop
//     entirely (need 3 distinct entries per game rules).
//
// Writes a .bak alongside the original so the change is reversible.
//
// Usage:
//   node scripts/fixZhPool.js          # apply fix
//   node scripts/fixZhPool.js --dry    # show what would change, don't write

const fs = require('fs');
const path = require('path');
const { toVariantTitle, normalizeArticle } = require('..' + path.sep + 'server.js');

const DRY = process.argv.includes('--dry');
const POOL_PATH = path.join(__dirname, '..', 'data', 'puzzlePool.zh.json');
const BAK_PATH = POOL_PATH + '.bak';

async function main() {
  const raw = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const pairs = raw.pairs || [];
  const triples = raw.triples || [];

  const titles = new Set();
  for (const p of pairs)   { titles.add(p.origin); titles.add(p.destination); }
  for (const t of triples) { for (const x of t.targets) titles.add(x); }

  console.log(`Resolving ${titles.size} unique titles → Simplified canonical form...`);
  const replace = new Map();
  let checked = 0;
  for (const title of titles) {
    checked++;
    process.stdout.write(`\r  [${checked}/${titles.size}]`);
    try {
      const canonical = await toVariantTitle(title, 'zh');
      if (canonical && canonical !== title) {
        replace.set(title, canonical);
      }
    } catch (e) {
      // Leave untouched on error — better stale than broken.
    }
  }
  process.stdout.write('\n\n');

  if (replace.size === 0) {
    console.log('✓ All titles already Simplified canonical. No changes.');
    return;
  }
  console.log(`Applying ${replace.size} title replacements:`);
  for (const [from, to] of replace) console.log(`  ${from}  →  ${to}`);
  console.log();

  // Rewrite pairs
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

  // Rewrite triples — drop any whose targets collapse to <3 distinct.
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

  const newPool = {
    ...raw,
    pairs: newPairs,
    triples: newTriples,
  };
  // Bump generatedAt so downstream cache-busters notice.
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
