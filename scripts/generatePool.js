#!/usr/bin/env node
// Generate a pool of solvable puzzles (English Wikipedia) so the live server
// rarely has to hit Wikipedia at game start. Solvability = we can compute a
// finite distance from origin to destination using cacheDestination +
// computeDistance.
//
// Usage:
//   node scripts/generatePool.js            # full pool → data/puzzlePool.en.json
//   node scripts/generatePool.js --fast     # small run for local sanity
//
// The generator picks its own articles. It used to call getRandomPair /
// getRandomTriple, which read the committed pool first, so a "refresh" only
// re-validated and reshuffled the entries it already had (every pair in the
// Oct 2026 pool was already in the April one). Worse, the runtime's inclusive
// range match let a request for one bucket take the next bucket's entries, and
// the top-viewed list fell back to famous articles when a range had few hits,
// so labels drifted: only 12 of the 47 "easy" destinations really had 500K+
// monthly views, and "hard" held China and Germany. Every title here is now
// measured (two 30-day windows of real page views) before it gets a label.

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  getTopViewedArticles,
  validateArticles,
  isBadTitle,
  resolveRedirect,
  getPageLinks,
  cacheDestination,
  computeDistance,
  normalizeArticle,
  HARDCODED_DAILY_BLACKLIST,
  WIKI_HOSTS,
} = require('..' + path.sep + 'server.js');

// ─── Config ───
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const LANG = 'en';
const UA = 'WikiSpeedrun/1.0 (https://wikispeedrun.io; mailto:hello@wikispeedrun.io)';

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
// The daily draws only on easy pairs with a 2-word destination at least 2 hops
// away, about 60% of the bucket, and must not repeat a destination for weeks;
// 50 easy pairs gave it 32 candidates and a 32-day cycle. Easy pairs are the
// cheapest to find (the top list), so the bucket is larger.
const EASY_PAIRS = FAST ? 3 : 80;
const pairsWanted = bucket => bucket.name === 'easy' ? EASY_PAIRS : PAIRS_PER_BUCKET;
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
// just with a thin or empty pool. Half is a floor for broken runs, not a
// quality bar; the refresh PR shows the real counts.
const MIN_POOL_SHARE = 0.5;

// Content the pool must not carry in any role: an origin or a `?` hub is as
// visible as a destination. HARDCODED_DAILY_BLACKLIST only covered daily
// destinations, so Sexual_intercourse → Australia was a curated daily and
// Hentai a `?` word.
// Real violent-crime articles are also out: Dnepropetrovsk_maniacs was the
// Oct 23 2026 daily destination. Wikipedia titles them "Murder of X",
// "Killing of X", "X massacre", "serial killer"; bare "murder"/"killer" would
// also drop fiction (Murder on the Orient Express, The Killers), so the
// crime patterns are phrase-shaped.
const DENY_WORDS = /\b(sex|sexual|sexuality|intercourse|penis|vagina|vulva|clitoris|testicles?|scrotum|anus|genitals?|ejaculation|erection|hentai|porn|pornography|pornographic|pornstar|erotic|erotica|nude|nudity|masturbation|orgasm|fetish|bdsm|incest|strip club|strippers?|prostitution|prostitutes?|brothel|sex workers?|suicide|self-harm|rape|xnxx|xvideos|pornhub|xhamster|onlyfans|brazzers|mofos|twistys|brasileirinhas|cam4|fanvue|chaturbate|stripchat|livejasmin|redtube|youporn|spankbang|bangbros|naughty america|reality kings|gang ?bang|bukkake|creampie|milf|dildo|vibrators?|sex toys?|maniacs?|massacres?|torture|beheading|snuff|necrophilia|pedophilia|paedophilia|cannibalism|serial killers?|murders? of|killings? of|mass shooting|school shooting|disappearance of|attacks|rule 34)\b/i;
function isDeniedTitle(title) {
  const spaced = title.replace(/_/g, ' ');
  return HARDCODED_DAILY_BLACKLIST.has(title) || DENY_WORDS.test(spaced)
    // "Neatsville, Kentucky" had 2.2M "human" views in a month: a known
    // pageview anomaly. Comma titles are place disambiguators and the like,
    // and the anomalies cluster there; nothing a player misses.
    || spaced.includes(',');
}

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

const sleep = ms => new Promise(r => setTimeout(r, ms));
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// Why this pool shouldn't replace the committed one; empty = fine to write.
function poolProblems(pool) {
  const problems = [];
  const minPairs = Math.ceil(BUCKETS.reduce((n, b) => n + pairsWanted(b), 0) * MIN_POOL_SHARE);
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

// ─── Candidate articles, measured ───

// Real page views (all access, human agents) for a title over [start, end],
// YYYYMMDD. The REST pageviews host is outside server.js's action-API queue.
// Null = unknown (the caller puts the title back for a later round). GitHub's
// runners share egress addresses and Wikimedia throttles them in bursts, so
// every request waits for a slot (spaced PV_SPACING_MS apart, all callers
// together) and a 429 pauses every caller for PV_PAUSE_MS before the retry.
// Without that, a run silently lost most measurements during a burst and
// looked like "few popular articles exist": the Oct 23 2026 branch runs got
// six, then five, easy titles out of 2,400 list candidates, because each
// failed title was also marked seen. The counters feed the summary.
const measureStats = { ok: 0, failed: 0, retried: 0, inflated: 0 };
const PV_SPACING_MS = 150;
const PV_PAUSE_MS = 8000;
let pvNextAt = 0;
let pvPauseUntil = 0;
async function pvSlot() {
  const now = Date.now();
  const at = Math.max(now, pvNextAt, pvPauseUntil);
  pvNextAt = at + PV_SPACING_MS;
  if (at > now) await sleep(at - now);
}
function viewsOnce(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve({ views: 0 }); // no views recorded at all
        if (res.statusCode !== 200) return resolve({ error: `http ${res.statusCode}` });
        try { resolve({ views: (JSON.parse(data).items || []).reduce((s, d) => s + (d.views || 0), 0) }); }
        catch (_) { resolve({ error: 'bad json' }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}
async function viewsBetween(title, start, end, lang, access = 'all-access') {
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/${access}/user/${encodeURIComponent(title)}/daily/${start}/${end}`;
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) { measureStats.retried++; await sleep(Math.min(15000, 1500 * 2 ** (attempt - 1))); }
    await pvSlot();
    last = await viewsOnce(url);
    if (last.views !== undefined) { measureStats.ok++; return last.views; }
    if (last.error === 'http 429') pvPauseUntil = Math.max(pvPauseUntil, Date.now() + PV_PAUSE_MS);
  }
  measureStats.failed++;
  if (measureStats.failed <= 5 || measureStats.failed % 50 === 0) console.error(`\n  pageviews failed for ${title}: ${last.error} (${measureStats.failed} so far)`);
  return null;
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const WINDOWS = (() => {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1); // yesterday: today is partial
  const mid = new Date(end); mid.setUTCDate(mid.getUTCDate() - 30);
  const start = new Date(mid); start.setUTCDate(start.getUTCDate() - 30);
  const dayAfter = d => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + 1); return x; };
  return { recent: [ymd(dayAfter(mid)), ymd(end)], prior: [ymd(dayAfter(start)), ymd(mid)] };
})();

// Two windows: the last 30 days and the 30 before. The recent one places the
// title in a bucket; the prior one must reach half the bucket floor, so a
// one-day news spike (the April pool had NBA_play-in_tournament and Nynetjer as
// "easy"; by autumn they had 1-2K views a month) fails, and a steady article
// a little below the floor last month still passes.
// The "user" agent filter still passes automated traffic that fakes a
// browser: Limonene, JSON-LD, RDFa and Neatsville,_Kentucky each showed
// 0.8-2.7M views in Sept 2026 with ≤1% from mobile, where every article
// real people read gets 30-90% of its views. A mobile share under 15% marks
// the title as inflated (checked once it has enough views to matter).
// Returns { recent, prior }, null for an inflated title, or undefined when a
// lookup failed (the title is not judged either way).
const MIN_MOBILE_SHARE = 0.15;
async function measure(title, lang) {
  const [recent, prior, mobile] = await Promise.all([
    viewsBetween(title, WINDOWS.recent[0], WINDOWS.recent[1], lang),
    viewsBetween(title, WINDOWS.prior[0], WINDOWS.prior[1], lang),
    viewsBetween(title, WINDOWS.recent[0], WINDOWS.recent[1], lang, 'mobile-web'),
  ]);
  if (recent === null || prior === null || mobile === null) return undefined;
  if (recent >= 50000 && mobile < recent * MIN_MOBILE_SHARE) { measureStats.inflated++; return null; }
  return { recent, prior };
}
function inBucket(v, bucket) {
  const [min, max] = bucket.viewRange;
  return v.recent >= min && v.recent <= max && v.prior >= min / 2;
}

// Per-bucket queues of measured, canonical, validated titles, refilled from
// the samplers as they drain. A title is measured once per run and lands in
// whichever bucket its views fit, not only the one being filled: the easy
// sampler measures plenty of 200-500K articles, which are medium's.
const seenTitles = new Set();
const queues = new Map(BUCKETS.map(b => [b.name, []]));
const bucketTitles = new Map(BUCKETS.map(b => [b.name, []])); // every title measured into the bucket
const useCount = new Map(); // title -> puzzles it was handed to
const views = new Map(); // title -> recent views

// Easy and medium come from the monthly top-1000 lists of the last three full
// months (the bottom of a month's list is ~220K views) plus the day's list;
// hard and expert from the outgoing links of random popular articles, which
// land mostly in the 5K-500K range and are well connected by construction.
// The old random-article sampler found a 5K-50K article in roughly one of
// fifty draws. A single day's list was too thin for easy and medium (the
// Oct 23 2026 run got 12 easy and 13 medium pairs): a day's top-1000 is
// mostly that day's news, and the steady articles it holds run out fast.
// When the lists are exhausted the hub-link sampler takes over for every
// bucket.
function topMonthly(lang, y, m) {
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${lang}.wikipedia/all-access/${y}/${String(m).padStart(2, '0')}/all-days`;
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve((JSON.parse(data).items?.[0]?.articles || []).map(a => ({ title: a.article, views: a.views }))); }
        catch (_) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => req.destroy());
  });
}
let listCache = null; // [{ title, views }] with a title's best month, shuffled
async function popularList(lang) {
  if (listCache) return listCache;
  const best = new Map();
  const add = (title, v) => { if (!/^(Main_Page|Special:|Wikipedia:|Portal:|Help:|File:|Talk:|Category:|Template:)/.test(title)) best.set(title, Math.max(best.get(title) || 0, v)); };
  const d = new Date(); d.setUTCDate(1);
  for (let i = 1; i <= 3; i++) {
    d.setUTCMonth(d.getUTCMonth() - 1);
    for (const a of await topMonthly(lang, d.getUTCFullYear(), d.getUTCMonth() + 1)) add(a.title, a.views);
  }
  for (const a of await getTopViewedArticles(lang)) add(a.title, a.views); // ×30 of one day
  listCache = shuffle([...best].map(([title, views]) => ({ title, views })).filter(a => !isBadTitle(a.title) && !isDeniedTitle(a.title)));
  console.log(`\n  popular lists: ${listCache.length} distinct titles (${listCache.filter(a => a.views >= 400000).length} at 400K+)`);
  return listCache;
}
let hubCache = null;
async function sampleTitles(bucket, lang) {
  if (bucket.viewRange[0] >= 50000) {
    // A list month's views are only a pre-filter; measure() decides.
    const [min, max] = bucket.viewRange;
    const list = (await popularList(lang)).filter(a => a.views >= min * 0.8 && a.views <= max * 1.5 && !seenTitles.has(a.title));
    if (list.length) return list.slice(0, 40).map(a => a.title);
  }
  if (!hubCache) hubCache = shuffle((await getTopViewedArticles(lang)).map(a => a.title));
  const hub = hubCache[Math.floor(Math.random() * hubCache.length)];
  if (!hub) return [];
  const links = [...await getPageLinks(hub, lang)].map(t => t.replace(/ /g, '_'));
  return shuffle(links).slice(0, 40);
}

async function refill(bucket, lang) {
  for (let round = 0; round < 6 && queues.get(bucket.name).length < 4; round++) {
    let titles;
    try { titles = await sampleTitles(bucket, lang); } catch (e) { console.error('\n  sample failed:', e.message); continue; }
    titles = titles.filter(t => !seenTitles.has(t));
    // Every sampled title counts as seen, rejected ones included: the list
    // sampler walks the list in order and skips seen titles only, so an
    // unmarked reject would sit at the front of every later sample (the Oct
    // 23 2026 run's easy samples were 40 titles with 5 new ones by round 5).
    titles.forEach(t => seenTitles.add(t));
    titles = titles.filter(t => !isBadTitle(t) && !isDeniedTitle(t));
    if (!titles.length) continue;
    // Real content pages only (no disambiguation, no stubs). The default
    // biography rule (100KB+, at most half as many as other articles) is
    // made for random play; the popular lists are mostly people, and a
    // famous person is a fine easy destination, so no cap on biographies.
    // The API takes 20 at a time.
    let valid = [];
    for (let i = 0; i < titles.length; i += 20) {
      try { valid.push(...await validateArticles(titles.slice(i, i + 20), lang, { minBioLength: 40000, bioRatio: null })); } catch (_) { /* next chunk */ }
    }
    valid = valid.filter(t => !isBadTitle(t) && !isDeniedTitle(t)); // the API's canonical spelling may differ
    let failed = 0;
    const measured = await mapLimit(valid, 4, async (t) => {
      const canon = await resolveRedirect(t, lang);
      if (canon !== t && (seenTitles.has(canon) || isBadTitle(canon) || isDeniedTitle(canon))) return null;
      seenTitles.add(canon);
      const v = await measure(canon, lang);
      if (v === undefined) {
        // Unknown, not unfit: the list sampler offers the title again next
        // round (it only skips seen titles).
        seenTitles.delete(canon);
        seenTitles.delete(t);
        failed++;
        return null;
      }
      const fits = v && BUCKETS.find(b => inBucket(v, b));
      return fits ? { title: canon, recent: v.recent, bucket: fits.name } : null;
    });
    for (const m of measured) {
      if (!m) continue;
      views.set(m.title, m.recent);
      useCount.set(m.title, 0);
      queues.get(m.bucket).push(m.title);
      bucketTitles.get(m.bucket).push(m.title);
    }
    if (failed && !measured.some(Boolean)) {
      // Everything failed: the API is throttling us. Let it cool down before
      // the same titles come round again.
      console.error(`\n  page views: ${failed} lookups failed in a row, pausing 30s`);
      await sleep(30000);
    }
  }
}

// Take n distinct measured titles for a bucket: fresh ones while the samplers
// find them, then the bucket's least-used titles again. Steady 500K+/month
// articles are rare (a few hundred exist, fewer pass validation), so easy
// cannot fill 80 pairs and 25 triples from distinct titles; what the game
// needs is distinct puzzles (the pair/triple dedup below) and, for the
// daily, as many distinct destinations as possible, which least-used-first
// gives. Null when the bucket has fewer than n titles in all.
async function takeTitles(bucket, n, lang) {
  const q = queues.get(bucket.name);
  if (q.length < n) await refill(bucket, lang);
  const picked = q.splice(0, Math.min(n, q.length));
  if (picked.length < n) {
    const all = bucketTitles.get(bucket.name).filter(t => !picked.includes(t));
    if (picked.length + all.length < n) { q.push(...picked); return null; }
    shuffle(all).sort((a, b) => useCount.get(a) - useCount.get(b));
    picked.push(...all.slice(0, n - picked.length));
  }
  picked.forEach(t => useCount.set(t, useCount.get(t) + 1));
  return picked;
}

// ─── Puzzle building ───

async function generatePairForBucket(lang, bucket) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SLOT; attempt++) {
    try {
      const picked = await takeTitles(bucket, 2, lang);
      if (!picked) return null;
      const [origin, destination] = picked;
      // Validate solvability: compute distance with live hop1/hop2 data.
      const destData = await cacheDestination(destination, lang);
      // Backlink minimum: a destination with too few inbound links is
      // effectively unwinnable. But hop1.size === 0 from cacheDestination
      // can mean EITHER "truly isolated" OR "API call failed silently" —
      // confirm with a focused retry before rejecting. Inconclusive
      // (likely-flaky) results just skip this pair without polluting the
      // rejection log.
      if (!destData?.hop1 || destData.hop1.size < MIN_DEST_BACKLINKS) {
        const verdict = await isDestinationActuallySparse(destination, lang);
        if (verdict.sparse === true) {
          sparseRejections.set(destination, verdict.count);
          continue;
        } else if (verdict.sparse === null) {
          // Inconclusive — try a fresh pair, don't blame the destination.
          continue;
        }
        // verdict.sparse === false → destination is actually healthy, fall
        // through into normal pair-solvability flow below.
      }
      const dist = await computeDistance(origin, destination, destData, lang);
      if (dist !== null && dist <= SOLVABLE_MAX_DIST) {
        return {
          origin,
          destination,
          viewRange: bucket.viewRange,
          difficulty: bucket.name,
          dist,
          views: { origin: views.get(origin), destination: views.get(destination) },
        };
      }
    } catch (e) {
      // Rate-limited or transient. Back off briefly and retry.
      await sleep(500 + attempt * 500);
    }
  }
  return null;
}

async function generateTripleForBucket(lang, bucket) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SLOT; attempt++) {
    try {
      const picked = await takeTitles(bucket, 3, lang);
      if (!picked) return null;
      // Solvability check for tri mode: start → t1 and start → t2 must both
      // reach within SOLVABLE_MAX_DIST. We don't enforce full 3-way.
      const [start, t1, t2] = picked;
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
        targets: picked,
        viewRange: bucket.viewRange,
        difficulty: bucket.name,
        distances: [d1, d2],
        views: picked.map(t => views.get(t)),
      };
    } catch (e) {
      await sleep(500 + attempt * 500);
    }
  }
  return null;
}

async function generateForLang(lang) {
  console.log(`\n═══ Generating pool for [${lang}] ═══`);
  console.log(`  views measured over ${WINDOWS.recent[0]}–${WINDOWS.recent[1]} (and ${WINDOWS.prior[0]}–${WINDOWS.prior[1]} before)`);
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
    const want = pairsWanted(bucket);
    const maxSlotAttempts = want * 3; // prevent runaway on thin buckets
    while (got < want && slotAttempts < maxSlotAttempts) {
      slotAttempts++;
      const entry = await generatePairForBucket(lang, bucket);
      if (!entry) continue;
      const key = `${normalizeArticle(entry.origin)}→${normalizeArticle(entry.destination)}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      pool.pairs.push(entry);
      got++;
      logProgress(lang, 'pairs  ', bucket.name, got, want);
    }
    if (got < want) process.stdout.write('\n');

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
  const summary = poolSummary(readPoolFile(outPath), pool)
    + `\n\nPage views: ${measureStats.ok} measured, ${measureStats.failed} failed after retries (${measureStats.retried} retries), ${measureStats.inflated} titles dropped as inflated.`;
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
  if (!WIKI_HOSTS[LANG]) throw new Error(`no Wikipedia host for ${LANG}`);
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
