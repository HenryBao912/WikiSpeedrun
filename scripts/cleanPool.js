#!/usr/bin/env node
// Removes unplayable / unsuitable destinations from the committed puzzle pools:
//   - SPARSE destinations: fewer than MIN_BACKLINKS (15) mainspace backlinks, so
//     they're effectively unreachable (the "1win" / "Raindrop_cake" incidents).
//     This is the same guardrail the runtime + generator use; running it as a
//     one-off scrubs entries that slipped in while the generator's check was
//     dead (getBacklinks wasn't exported).
//   - DENYLISTED destinations: content unsuitable for a shareable random/daily
//     target.
// Pairs are dropped if their `destination` is bad. Triples are dropped if any of
// their destination targets (targets[1], targets[2]) is bad. Start articles are
// never backlink-checked (you start there; only reachability of the *target*
// matters).
//
// Usage: node scripts/cleanPool.js [--dry] [--lang en|zh]
// Reuses server.js's countBacklinks (redirect-resolving, fail-open, cached) and
// its global request concurrency limiter, so it won't trip Wikipedia's 429s.

const fs = require('fs');
const path = require('path');
const { countBacklinks, normalizeArticle } = require('..' + path.sep + 'server.js');

const MIN_BACKLINKS = 15;
const DRY = process.argv.includes('--dry');
const LANG_ARG = (() => { const i = process.argv.indexOf('--lang'); return i >= 0 ? process.argv[i + 1] : null; })();
const LANGS = LANG_ARG ? [LANG_ARG] : ['en', 'zh'];

// Content unsuitable for a shareable random/daily puzzle target, plus specific
// articles confirmed sparse in production incidents. Explicit list (not fuzzy
// keyword matching) so legitimate history/science articles aren't wrongly
// scrubbed. These are removed regardless of the live backlink count, so a
// transient 429 during the audit can't let them survive. Matched on normalized
// title.
const DENYLIST = new Set([
  // sensitive content
  'suicide methods', 'suicide', 'self-harm', 'list of suicides',
  // confirmed-sparse prod incidents (daily/start rejections)
  '1win', 'raindrop cake',
].map(s => s.replace(/_/g, ' ').toLowerCase()));

function isDenied(title) {
  return DENYLIST.has(normalizeArticle(title));
}

async function cleanLang(lang) {
  const file = path.join(__dirname, '..', 'data', `puzzlePool.${lang}.json`);
  const pool = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pairs = pool.pairs || [];
  const triples = pool.triples || [];

  // Collect unique destination titles to check.
  const dests = new Set();
  for (const p of pairs) dests.add(p.destination);
  for (const t of triples) for (const d of (t.targets || []).slice(1)) dests.add(d);

  console.log(`\n[${lang}] auditing ${dests.size} unique destinations (${pairs.length} pairs, ${triples.length} triples)…`);

  const bad = new Map(); // title -> reason
  const denied = [...dests].filter(isDenied);
  for (const t of denied) bad.set(t, 'denylisted');

  // Backlink-count the rest. countBacklinks returns null on a fetch failure
  // (fail-open) — but null means "unknown", not "fine", so we re-audit nulls a
  // few passes (the rate limiter paces them) rather than silently keeping a
  // possibly-sparse article. Only a CONFIRMED count < threshold is removed.
  let pending = [...dests].filter(t => !isDenied(t));
  for (let pass = 1; pass <= 3 && pending.length; pass++) {
    const stillUnknown = [];
    let done = 0;
    await Promise.all(pending.map(async (title) => {
      const count = await countBacklinks(title, MIN_BACKLINKS, lang);
      if (count === null) stillUnknown.push(title);
      else if (count < MIN_BACKLINKS) bad.set(title, `sparse(${count})`);
      done++;
      if (done % 50 === 0) console.log(`  pass ${pass}: …${done}/${pending.length}`);
    }));
    console.log(`  pass ${pass}: ${pending.length - stillUnknown.length} resolved, ${stillUnknown.length} still unknown (429) → retry`);
    pending = stillUnknown;
  }
  if (pending.length) console.log(`  ${pending.length} destinations stayed unknown after retries — kept (fail open): ${pending.slice(0, 8).join(', ')}${pending.length > 8 ? '…' : ''}`);

  if (bad.size === 0) { console.log(`[${lang}] clean — nothing to remove.`); return { lang, removed: 0 }; }

  console.log(`[${lang}] removing ${bad.size} bad destination(s):`);
  for (const [t, r] of bad) console.log(`    - ${t}  [${r}]`);

  const keptPairs = pairs.filter(p => !bad.has(p.destination));
  const keptTriples = triples.filter(t => !(t.targets || []).slice(1).some(d => bad.has(d)));
  const removedPairs = pairs.length - keptPairs.length;
  const removedTriples = triples.length - keptTriples.length;
  console.log(`[${lang}] pairs ${pairs.length}→${keptPairs.length} (-${removedPairs}), triples ${triples.length}→${keptTriples.length} (-${removedTriples})`);

  if (!DRY) {
    pool.pairs = keptPairs;
    pool.triples = keptTriples;
    fs.writeFileSync(file, JSON.stringify(pool, null, 2));
    console.log(`[${lang}] wrote ${path.relative(process.cwd(), file)}`);
  } else {
    console.log(`[${lang}] --dry: no file written`);
  }
  return { lang, removed: bad.size, removedPairs, removedTriples };
}

(async () => {
  console.log(`Pool cleanup (threshold ${MIN_BACKLINKS} backlinks)${DRY ? ' [DRY RUN]' : ''}`);
  for (const lang of LANGS) await cleanLang(lang);
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
