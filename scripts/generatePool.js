#!/usr/bin/env node
// Generate a pool of solvable puzzles (English Wikipedia) so the live server
// rarely has to hit Wikipedia at game start. Solvability = we can compute a
// finite distance from origin to destination using cacheDestination +
// computeDistance.
//
// Usage:
//   node scripts/generatePool.js            # full pool → data/puzzlePool.en.json
//   node scripts/generatePool.js --fast     # small run for local sanity

const fs = require('fs');
const path = require('path');
const {
  getRandomPair,
  getRandomTriple,
  getGoodRandomArticles,
  cacheDestination,
  computeDistance,
  normalizeArticle,
} = require('..' + path.sep + 'server.js');

// ─── Config ───
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const LANG = 'en';

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
// entirely. Tracks count of rejected pairs for the end-of-run report.
const MIN_DEST_BACKLINKS = 15;
const sparseRejections = new Map(); // destination -> backlinks count

// Smallest pool worth writing, as a share of the per-bucket targets summed.
// A run starved by Wikipedia 429s (or with no network at all) still finishes,
// just with a thin or empty pool. Recent full runs land near 150 pairs and 72
// triples (easy and medium fill; expert gets ~10 of 50), so half is a floor
// for broken runs, not a quality bar; the refresh PR shows the real counts.
const MIN_POOL_SHARE = 0.5;

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

// Why this pool shouldn't replace the committed one; empty = fine to write.
function poolProblems(pool) {
  const problems = [];
  const minPairs = Math.ceil(PAIRS_PER_BUCKET * BUCKETS.length * MIN_POOL_SHARE);
  const minTriples = Math.ceil(TRIPLES_PER_BUCKET * BUCKETS.length * MIN_POOL_SHARE);
  if (pool.pairs.length < minPairs) problems.push(`${pool.pairs.length} pairs (need ${minPairs})`);
  if (pool.triples.length < minTriples) problems.push(`${pool.triples.length} triples (need ${minTriples})`);
  // An empty bucket is worse than a thin one: pickFromPool falls back to any
  // entry, so that difficulty would quietly serve puzzles from the others.
  for (const { name } of BUCKETS) {
    if (!pool.pairs.some(p => p.difficulty === name)) problems.push(`no ${name} pairs`);
    if (!pool.triples.some(t => t.difficulty === name)) problems.push(`no ${name} triples`);
  }
  return problems;
}

// Per-bucket counts, committed pool → this run, as a Markdown table. Printed,
// and written to $POOL_SUMMARY_FILE for the refresh workflow's PR body.
function poolSummary(prev, pool) {
  const count = (list, name) => (list || []).filter(e => !name || e.difficulty === name).length;
  const cell = (key, name) => (prev ? `${count(prev[key], name)} → ` : '') + count(pool[key], name);
  return [
    prev ? `Committed pool: generated ${prev.generatedAt || 'at an unknown date'}.` : 'No committed pool.',
    '',
    '| Bucket | Pairs | Triples |',
    '|---|---|---|',
    ...BUCKETS.map(({ name }) => `| ${name} | ${cell('pairs', name)} | ${cell('triples', name)} |`),
    `| total | ${cell('pairs')} | ${cell('triples')} |`,
  ].join('\n');
}

function readPoolFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

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
        return {
          origin: pair.origin,
          destination: pair.destination,
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
      return {
        targets: triple.targets,
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

  // Dedup — don't let the same origin/destination repeat.
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
  const summary = poolSummary(readPoolFile(outPath), pool);
  console.log(`\n${summary}`);
  const problems = poolProblems(pool);
  if (problems.length > 0) {
    throw new Error(`pool too small, kept the committed ${path.basename(outPath)} (${elapsed}s):\n  - ${problems.join('\n  - ')}`);
  }
  fs.writeFileSync(outPath, JSON.stringify(pool, null, 2));
  if (process.env.POOL_SUMMARY_FILE) fs.writeFileSync(process.env.POOL_SUMMARY_FILE, summary + '\n');
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
  }
}

// ─── Main ───
(async () => {
  console.log(FAST ? '⚡ Fast mode (small pool, for sanity checks)' : '🏗  Full pool generation');
  try {
    await generateForLang(LANG);
    console.log('\nDone. Commit data/puzzlePool.en.json so the deploy ships warm.\n');
  } catch (e) {
    console.error(`\n✗ [${LANG}] Failed:`, e.message);
    process.exitCode = 1;
  }
  // No argument, so a failure's exitCode = 1 survives. exit(0) used to
  // override it, and a failed run showed green in Actions.
  process.exit();
})();
