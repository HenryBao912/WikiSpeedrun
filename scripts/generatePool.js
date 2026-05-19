#!/usr/bin/env node
// Generate a pool of solvable puzzles per language so the live server rarely
// has to hit Wikipedia at game start. Solvability = we can compute a finite
// distance from origin to destination using cacheDestination + computeDistance.
//
// Usage:
//   node scripts/generatePool.js            # default: en + zh, full pool
//   node scripts/generatePool.js --lang en  # one language
//   node scripts/generatePool.js --fast     # small run for local sanity

const fs = require('fs');
const path = require('path');
const {
  getRandomPair,
  getRandomTriple,
  getGoodRandomArticles,
  cacheDestination,
  computeDistance,
  toVariantTitle,
  normalizeArticle,
} = require('..' + path.sep + 'server.js');

// ─── Config ───
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const argLang = (() => {
  const i = args.indexOf('--lang');
  return i >= 0 ? args[i + 1] : null;
})();
const LANGS = argLang ? [argLang] : ['en', 'zh'];

// Difficulty buckets — tuned to the client's slider. Each bucket picks pairs
// where both articles have pageviews-per-month in the given range.
const BUCKETS = [
  { name: 'easy',   viewRange: [500000, 100000000] },
  { name: 'medium', viewRange: [50000,   500000] },
  { name: 'hard',   viewRange: [5000,    50000] },
  { name: 'expert', viewRange: [1000,    5000] },
];

const PAIRS_PER_BUCKET   = FAST ? 3 : 50;
const TRIPLES_PER_BUCKET = FAST ? 2 : 25;
// How hard to try for each slot before giving up. Unsolvable pairs don't get
// written — they'd be a bad game experience.
const MAX_ATTEMPTS_PER_SLOT = FAST ? 2 : 5;
// Any distance ≤ this counts as solvable. computeDistance returns 6 when no
// path is proven — that's unsolvable for our purposes.
const SOLVABLE_MAX_DIST = 5;
// Destinations with fewer than this many backlinks make the game effectively
// unwinnable for most players (handful of entry paths into the destination,
// invisible from typical origins). Mirrors the runtime guardrail in
// startGameForRoom. "1win" had 350K monthly views but only 3 backlinks; the
// runtime guardrail caught it, but only AFTER it made it into the pool.
// Validating here at build time keeps bad destinations out of the pool
// entirely. Tracks count of rejected pairs for the per-language report.
const MIN_DEST_BACKLINKS = 15;
const sparseRejections = new Map(); // destination -> backlinks count

// Distinguish "API returned no backlinks" from "API call failed silently".
// cacheDestination uses getBacklinks(2000) which returns an empty Set on
// error (rate-limit, timeout). We retry once with a small explicit limit
// to confirm sparseness before rejecting — otherwise a transient blip
// would falsely cull big-name destinations (Leonardo_DiCaprio, Henry_VIII).
// True if confirmed sparse, false if API seems flaky (caller skips, no
// rejection logged).
async function isDestinationActuallySparse(destination, lang) {
  // Direct getBacklinks call — bypasses cacheDestination's heavier path so
  // a single failed retry is cheap. We deliberately re-import here to keep
  // the runtime guardrail's exact behavior (also uses getBacklinks).
  const { getBacklinks } = require('..' + path.sep + 'server.js');
  try {
    const links = await getBacklinks(destination, MIN_DEST_BACKLINKS + 5, lang);
    // <MIN with a real reply = truly sparse → reject.
    if (links.size >= MIN_DEST_BACKLINKS) return { sparse: false, count: links.size };
    // 0 with no error is suspicious — could be API failure that silently
    // returned empty. Retry once with a small back-off.
    await new Promise(r => setTimeout(r, 1500));
    const retry = await getBacklinks(destination, MIN_DEST_BACKLINKS + 5, lang);
    if (retry.size >= MIN_DEST_BACKLINKS) return { sparse: false, count: retry.size };
    if (retry.size === 0 && links.size === 0) {
      // Two zeroes in a row could STILL be a flaky API on this destination.
      // Treat as inconclusive — don't reject, don't log; skip the pair and
      // let the generator try a different one.
      return { sparse: null, count: 0 };
    }
    // Got a small non-zero count both attempts → genuinely sparse.
    return { sparse: true, count: Math.max(links.size, retry.size) };
  } catch (e) {
    // Exception bubbled up — definitely an API problem. Inconclusive.
    return { sparse: null, count: 0 };
  }
}

const OUT_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Helpers ───

function logProgress(lang, kind, bucket, have, want) {
  const pct = Math.round((have / want) * 100);
  process.stdout.write(`\r  [${lang}] ${kind} ${bucket.padEnd(7)} ${String(have).padStart(3)}/${want} (${pct}%)`);
  if (have >= want) process.stdout.write('\n');
}

async function generatePairForBucket(lang, bucket) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SLOT; attempt++) {
    try {
      const pair = await getRandomPair(bucket.viewRange, lang);
      // Validate solvability: compute distance with live hop1/hop2 data.
      const destData = await cacheDestination(pair.destination, lang);
      // Backlink minimum: a destination with too few inbound links is
      // effectively unwinnable. But hop1.size === 0 from cacheDestination
      // can mean EITHER "truly isolated" OR "API call failed silently" —
      // confirm with a focused retry before rejecting. Inconclusive
      // (likely-flaky) results just skip this pair without polluting the
      // rejection log.
      if (!destData?.hop1 || destData.hop1.size < MIN_DEST_BACKLINKS) {
        const verdict = await isDestinationActuallySparse(pair.destination, lang);
        if (verdict.sparse === true) {
          sparseRejections.set(pair.destination, verdict.count);
          continue;
        } else if (verdict.sparse === null) {
          // Inconclusive — try a fresh pair, don't blame the destination.
          continue;
        }
        // verdict.sparse === false → destination is actually healthy, fall
        // through into normal pair-solvability flow below.
      }
      const dist = await computeDistance(pair.origin, pair.destination, destData, lang);
      if (dist !== null && dist <= SOLVABLE_MAX_DIST) {
        // For variant-aware wikis (zh), convert titles to the display variant
        // (Simplified) before writing so the pool never stores Traditional.
        const [origin, destination] = await Promise.all([
          toVariantTitle(pair.origin, lang),
          toVariantTitle(pair.destination, lang),
        ]);
        return {
          origin,
          destination,
          viewRange: bucket.viewRange,
          difficulty: bucket.name,
          dist,
        };
      }
    } catch (e) {
      // Rate-limited or transient. Back off briefly and retry.
      await new Promise(r => setTimeout(r, 500 + attempt * 500));
    }
  }
  return null;
}

async function generateTripleForBucket(lang, bucket) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SLOT; attempt++) {
    try {
      const triple = await getRandomTriple(bucket.viewRange, lang);
      if (!triple?.targets || triple.targets.length !== 3) continue;
      // Solvability check for tri mode: start → t1 and start → t2 must both
      // reach within SOLVABLE_MAX_DIST. We don't enforce full 3-way.
      const [start, t1, t2] = triple.targets;
      const dest1Data = await cacheDestination(t1, lang);
      // Backlink minimum on both downstream targets (start is given, players
      // navigate TO t1 and t2). A sparse target makes the round unwinnable.
      // Same retry-on-zero defense as the pair path — don't blame the
      // destination for an API failure.
      if (!dest1Data?.hop1 || dest1Data.hop1.size < MIN_DEST_BACKLINKS) {
        const v1 = await isDestinationActuallySparse(t1, lang);
        if (v1.sparse === true) { sparseRejections.set(t1, v1.count); continue; }
        if (v1.sparse === null) continue;
      }
      const d1 = await computeDistance(start, t1, dest1Data, lang);
      if (d1 === null || d1 > SOLVABLE_MAX_DIST) continue;
      const dest2Data = await cacheDestination(t2, lang);
      if (!dest2Data?.hop1 || dest2Data.hop1.size < MIN_DEST_BACKLINKS) {
        const v2 = await isDestinationActuallySparse(t2, lang);
        if (v2.sparse === true) { sparseRejections.set(t2, v2.count); continue; }
        if (v2.sparse === null) continue;
      }
      const d2 = await computeDistance(start, t2, dest2Data, lang);
      if (d2 === null || d2 > SOLVABLE_MAX_DIST) continue;
      const convertedTargets = await Promise.all(triple.targets.map(t => toVariantTitle(t, lang)));
      return {
        targets: convertedTargets,
        viewRange: bucket.viewRange,
        difficulty: bucket.name,
        distances: [d1, d2],
      };
    } catch (e) {
      await new Promise(r => setTimeout(r, 500 + attempt * 500));
    }
  }
  return null;
}

async function generateForLang(lang) {
  console.log(`\n═══ Generating pool for [${lang}] ═══`);
  const startTime = Date.now();
  const pool = {
    generatedAt: new Date().toISOString(),
    lang,
    pairs: [],
    triples: [],
  };

  // Dedup within each language — don't let the same origin/destination repeat.
  const seenPairs = new Set();
  const seenTriples = new Set();

  for (const bucket of BUCKETS) {
    console.log(`\n• ${bucket.name} (views ${bucket.viewRange[0]}–${bucket.viewRange[1]})`);

    // Pairs
    let got = 0;
    let slotAttempts = 0;
    const maxSlotAttempts = PAIRS_PER_BUCKET * 3; // prevent runaway on thin buckets
    while (got < PAIRS_PER_BUCKET && slotAttempts < maxSlotAttempts) {
      slotAttempts++;
      const entry = await generatePairForBucket(lang, bucket);
      if (!entry) continue;
      const key = `${normalizeArticle(entry.origin)}→${normalizeArticle(entry.destination)}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      pool.pairs.push(entry);
      got++;
      logProgress(lang, 'pairs  ', bucket.name, got, PAIRS_PER_BUCKET);
    }
    if (got < PAIRS_PER_BUCKET) process.stdout.write('\n');

    // Triples
    got = 0;
    slotAttempts = 0;
    const maxTripleAttempts = TRIPLES_PER_BUCKET * 3;
    while (got < TRIPLES_PER_BUCKET && slotAttempts < maxTripleAttempts) {
      slotAttempts++;
      const entry = await generateTripleForBucket(lang, bucket);
      if (!entry) continue;
      const key = entry.targets.map(normalizeArticle).sort().join('|');
      if (seenTriples.has(key)) continue;
      seenTriples.add(key);
      pool.triples.push(entry);
      got++;
      logProgress(lang, 'triples', bucket.name, got, TRIPLES_PER_BUCKET);
    }
    if (got < TRIPLES_PER_BUCKET) process.stdout.write('\n');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const outPath = path.join(OUT_DIR, `puzzlePool.${lang}.json`);
  fs.writeFileSync(outPath, JSON.stringify(pool, null, 2));
  console.log(`\n✓ [${lang}] Wrote ${pool.pairs.length} pairs + ${pool.triples.length} triples → ${outPath} (${elapsed}s)`);
  // Surface sparse-destination rejections so we know what the runtime
  // guardrail would have caught at gameplay time. Empty = pool quality is
  // green; non-empty = these destinations would have been bad games and
  // should be tracked (consider auditing why they made it through view
  // filtering — usually trending news topics or commercial brands).
  if (sparseRejections.size > 0) {
    const sorted = [...sparseRejections.entries()].sort((a, b) => a[1] - b[1]);
    console.log(`  ⚠ Rejected ${sparseRejections.size} sparse destinations (<${MIN_DEST_BACKLINKS} backlinks):`);
    for (const [dest, count] of sorted.slice(0, 10)) {
      console.log(`     ${count.toString().padStart(3)} backlinks: ${dest}`);
    }
    if (sorted.length > 10) console.log(`     … and ${sorted.length - 10} more`);
    sparseRejections.clear(); // reset for next language
  }
}

// ─── Main ───
(async () => {
  console.log(FAST ? '⚡ Fast mode (small pool, for sanity checks)' : '🏗  Full pool generation');
  for (const lang of LANGS) {
    try {
      await generateForLang(lang);
    } catch (e) {
      console.error(`\n✗ [${lang}] Failed:`, e.message);
      process.exitCode = 1;
    }
  }
  console.log('\nDone. Commit data/puzzlePool.*.json so the deploy ships warm.\n');
  process.exit(0);
})();
