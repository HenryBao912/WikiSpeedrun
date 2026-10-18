#!/usr/bin/env node
// Wikipedia request-queue priority tests — run: node scripts/testWikiPriority.js
// No network, deterministic: https.get is stubbed for Wikipedia hosts with a
// fake that answers after a fixed delay (--latency, default 200ms) with JSON
// shaped like the real API, or with a 429 when a test asks for one. ~25s.
//
// Guards the Oct 18 2026 fix. Every server-side Wikipedia call shares one
// queue (WIKI_MAX_CONCURRENT in flight, WIKI_MIN_INTERVAL_MS between starts),
// and the click check a player waits on used to sit FIFO behind background
// work (cacheDestination, computeDistance's live verification). Under 429
// storms 1.45% of /action took >3s (p99 10s, max 33s). Now player-facing
// calls go first:
//
//   1. A click check queued behind 30 background fetches finishes after a
//      few slots, not after all 30. 1b: with every slot busy, its second
//      request takes the slot its first one freed (no background fetch slips
//      in between the two).
//   2. Promotion: a queued background getPageLinks(X) jumps the queue when a
//      click check that needs X joins it, and so do its later pages.
//   3. Background work started from player-facing code stays low: navigate's
//      computeDistance, the marathon pick's live-verification fan-out, and
//      game start's cacheDestination.
//   4. No starvation: background work completes under a steady stream of
//      player-priority requests.
//   5. Concurrency never exceeds WIKI_MAX_CONCURRENT and starts are spaced by
//      WIKI_MIN_INTERVAL_MS, asserted from the stub's own records.
//   6. A retry after a 429 keeps the request's priority, including a request
//      promoted while it was backing off.
//
// Like testWikiApi.js, this reaches internals through a patched require.
// --server <path/to/server.js> runs scenario 1 against another checkout, e.g.
// the code from before this change, for a before/after number. A server
// without withWikiPriority runs scenario 1 only, unprioritized.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const LATENCY_MS = Number(arg('--latency', 200));
const serverPath = path.resolve(arg('--server', path.join(__dirname, '..', 'server.js')));
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Fake Wikipedia ──
// Every request the server sends is recorded at the moment it reaches
// https.get: its key (kind:title, plus page/limit where it matters), a
// timestamp, and the priority it ran under, read from the server's own
// AsyncLocalStorage (https.get runs in the request's async context). Also
// the queue's own start stamp (wikiLastStart: the pump sets it just before it
// releases a request, and https.get runs before any other start can happen),
// and `end` when the response goes back.
const fake = {
  starts: [],
  inFlight: 0,
  maxInFlight: 0,
  links: new Map(),  // title -> pages of outgoing link titles (default: one page)
  fail: new Map(),   // request key -> how many 429s to answer before succeeding
};
let s; // the server module, loaded below

function classify(p) {
  const title = (p.titles || p.bltitle || '').replace(/_/g, ' ');
  if (p.list === 'backlinks') return { kind: 'backlinks', title, key: `backlinks:${title}/${p.bllimit}` };
  if (p.prop === 'links' && p.pltitles) return { kind: 'probe', title, key: `probe:${title}` };
  if (p.prop === 'links') {
    const page = p.plcontinue ? Number(p.plcontinue.split('|')[1]) : 0;
    return { kind: 'links', title, page, key: `links:${title}${page ? '#' + page : ''}` };
  }
  if (p.prop === 'redirects') return { kind: 'aliases', title, key: `aliases:${title}` };
  if (p.redirects === '1') return { kind: 'redirect', title, key: `redirect:${title}` };
  return { kind: 'other', title, key: `other:${title}` };
}

function respond(c, p) {
  const page = extra => ({ query: { pages: { 1: { ns: 0, title: c.title, ...extra } } } });
  switch (c.kind) {
    case 'links': {
      const pages = fake.links.get(c.title) || [['Generic link']];
      const out = page({ links: pages[c.page].map(t => ({ ns: 0, title: t })) });
      if (c.page + 1 < pages.length) out.continue = { plcontinue: `1|${c.page + 1}`, continue: '||' };
      return out;
    }
    case 'backlinks': {
      // 15 answers countBacklinks' sparse-destination probe in full (the game
      // starts); 3 keeps cacheDestination's hop2 fan-out small.
      const n = Number(p.bllimit) <= 15 ? Number(p.bllimit) : 3;
      return { query: { backlinks: Array.from({ length: n }, (_, i) => ({ ns: 0, title: `${c.title} bl ${i}` })) } };
    }
    default: // redirect: not a redirect; probe/aliases: none
      return page({});
  }
}

const realGet = https.get;
https.get = function (url, opts, cb) {
  const u = new URL(String(url));
  if (!/(^|\.)(wikipedia|wikimedia)\.org$/.test(u.hostname)) return realGet.apply(this, arguments);
  const p = Object.fromEntries(u.searchParams);
  const c = classify(p);
  const store = s && s.wikiPriority ? s.wikiPriority.getStore() : undefined;
  const rec = { key: c.key, t: Date.now(), queueT: s ? s.lastWikiStart() : null, high: !!(store && store.high) };
  fake.starts.push(rec);
  fake.maxInFlight = Math.max(fake.maxInFlight, rec.inFlight = ++fake.inFlight);
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => req;
  // Titles with "slow" in them answer at 5× latency (1b and 5 fill every slot).
  setTimeout(() => {
    fake.inFlight--;
    rec.end = Date.now();
    const res = new EventEmitter();
    res.headers = {};
    const fails = fake.fail.get(c.key) || 0;
    if (fails > 0) fake.fail.set(c.key, fails - 1);
    res.statusCode = fails > 0 ? 429 : 200;
    cb(res);
    res.emit('data', fails > 0 ? 'Too many requests' : JSON.stringify(respond(c, p)));
    res.emit('end');
  }, /\bslow\b/.test(c.title) ? LATENCY_MS * 5 : LATENCY_MS);
  return req;
};

// ── Load server.js with the internals these tests need ──
// typeof guards keep the patch valid against a server that predates a name.
const src = fs.readFileSync(serverPath, 'utf8');
const internals = [
  'isLegalMove', 'getPageLinks', 'handleAction', 'rooms', 'players', 'initRoom',
  'cacheSet', 'cacheKey', 'redirectCache', 'withWikiPriority', 'wikiPriority',
  'WIKI_MAX_CONCURRENT', 'WIKI_MIN_INTERVAL_MS', 'WIKI_MAX_LOW_SKIPS',
];
const patched = src.replace(/^module\.exports = \{/m, 'module.exports = {\n' +
  internals.map(n => `  ${n}: typeof ${n} === 'undefined' ? undefined : ${n},`).join('\n') +
  '\n  lastWikiStart: () => wikiLastStart,');
const tmp = path.join(path.dirname(serverPath), '_testWikiPriority_patched.cjs');
fs.writeFileSync(tmp, patched);
try { s = require(tmp); } finally { fs.unlinkSync(tmp); }
// The server logs every action and cache build; keep the test output readable.
if (!process.argv.includes('--verbose')) console.log = () => {};

const prioritized = typeof s.withWikiPriority === 'function';
const hi = fn => (prioritized ? s.withWikiPriority(fn) : fn());

let pass = 0, fail = 0;
const ok = (label, cond) => {
  say((cond ? '  ✅ ' : '  ❌ ') + label);
  cond ? pass++ : fail++;
};
const startsOf = re => fake.starts.filter(x => re.test(x.key));
async function until(cond, label, timeoutMs = 15000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

// A connected player in a started room, with an SSE sink that records messages.
function seatPlayer(playerId, roomCode, setup) {
  const msgs = [];
  const res = {
    writableEnded: false,
    write(chunk) {
      const m = /^data: (.*)\n\n$/s.exec(String(chunk));
      if (m) msgs.push(JSON.parse(m[1]));
      return true;
    },
  };
  s.players.set(playerId, { res, roomCode, name: 'Tester' });
  if (!setup) return { msgs };
  const room = s.initRoom(roomCode, playerId, 'Tester');
  room.started = true;
  room.startTime = room.raceStartTime = Date.now();
  const rp = room.players.get(playerId);
  setup(room, rp);
  s.rooms.set(roomCode, room);
  return { msgs, room, rp };
}

// ── 1. Click check behind a queue of background fetches ──
async function scenarioLatency() {
  const bg = [];
  for (let i = 0; i < 30; i++) bg.push(s.getPageLinks(`S1 low ${i}`));
  fake.links.set('S1 from', [['S1 target', 'S1 other']]);
  const t0 = Date.now();
  const legal = await hi(() => s.isLegalMove('S1 from', 'S1 target'));
  const tDone = Date.now();
  await Promise.all(bg);
  const lowsFirst = startsOf(/^links:S1 low /).filter(x => x.t <= tDone).length;
  const clickReqs = startsOf(/^(redirect|links):S1 from$/);
  return { legal, ms: tDone - t0, lowsFirst, clickReqs };
}

// ── 1b. The click check keeps its slot between steps ──
async function scenarioHandOff() {
  // Slow background fetches (5× latency) take three slots and the click check
  // the fourth, so every slot is busy and the interval long passed when its
  // first request returns. Only the hand-off decides who gets that slot:
  // pumping inline gave it to the oldest background waiter before the click
  // check's second request was queued.
  const bg = [];
  for (let i = 0; i < 8; i++) bg.push(s.getPageLinks(`S1b slow ${i}`));
  await until(() => startsOf(/^links:S1b slow /).length >= 3, 'three slow fetches in flight');
  fake.links.set('S1b from', [['S1b target']]);
  const t0 = Date.now();
  const legal = await hi(() => s.isLegalMove('S1b from', 'S1b target'));
  const ms = Date.now() - t0;
  await Promise.all(bg);
  const [first, second] = startsOf(/^(redirect|links):S1b from$/);
  const lowsBetween = startsOf(/^links:S1b slow /).filter(x => x.t >= first.end && x.t < second.t).length;
  return { legal, ms, allBusy: first.inFlight === s.WIKI_MAX_CONCURRENT, lowsBetween };
}

// ── 2. Promotion through coalescing ──
async function scenarioPromotion() {
  const bg = [];
  for (let i = 0; i < 30; i++) bg.push(s.getPageLinks(`S2 low ${i}`));
  // A background fetch of X (as navigate's computeDistance makes), three
  // pages long, queued behind the 30.
  fake.links.set('S2 x', [['S2 next'], ['S2 a'], ['S2 b']]);
  const lowX = s.getPageLinks('S2 x');
  bg.push(lowX);
  // The player's next click is from X. Its redirect is cached (the previous
  // click's win check resolved it), so its first need is getPageLinks(X).
  s.cacheSet(s.redirectCache, s.cacheKey('en', 'S2 x'), 'S2_x');
  await sleep(50);
  const startedBeforeJoin = startsOf(/^links:S2 x/).length;
  const joinAt = Date.now();
  const startsAtJoin = fake.starts.length;
  const legal = await hi(() => s.isLegalMove('S2 x', 'S2 next'));
  const ms = Date.now() - joinAt;
  const xPages = startsOf(/^links:S2 x/);
  const xFirstIdx = fake.starts.findIndex(x => x.key === 'links:S2 x');
  await Promise.all(bg);
  return { legal, ms, startedBeforeJoin, xPages, startsAhead: xFirstIdx - startsAtJoin };
}

// ── 3. Background work launched from player-facing code stays low ──
async function scenarioBackground() {
  const prio = re => startsOf(re).map(x => x.high);
  const allLow = re => prio(re).length > 0 && prio(re).every(h => !h);
  const allHigh = re => prio(re).length > 0 && prio(re).every(h => h);

  // 3a. navigate (classic): the move check and win check are awaited (high);
  // the distance computation it fires off is not (low), fan-out included.
  fake.links.set('S3a from', [['S3a target']]);
  fake.links.set('S3a target', [['S3a mid 1', 'S3a mid 2']]);
  const a = seatPlayer('s3a-player', 'S3A00', (room, rp) => {
    room.mode = 'classic';
    room.pair = { origin: 'S3a from', destination: 'S3a dest' };
    room.destData = { hop1: new Set(['s3a nowhere']), hop2: new Set(), aliases: new Set(['s3a dest']) };
    rp.path = ['S3a from'];
    rp.distances = [3];
  });
  const r = await s.handleAction('s3a-player', { type: 'navigate', article: 'S3a target' });
  await until(() => a.rp.distances[1] !== undefined, 'navigate distance');
  ok(`navigate accepted (${JSON.stringify(r)})`, r && r.ok === true);
  ok('navigate: move check + win check ran high (redirect + links of from, redirect of target)',
    allHigh(/^redirect:S3a from$/) && allHigh(/^links:S3a from$/) && allHigh(/^redirect:S3a target$/));
  ok('navigate: the distance it fires off ran low (links of target + live-verification fan-out)',
    allLow(/^links:S3a target$/) && allLow(/^links:s3a mid /));

  // 3b. mk_request_next: the pick is awaited (high) but computeDistance's
  // live-verification fan-out inside it is demoted (low).
  fake.links.set('S3b start', [['S3b mid 1', 'S3b mid 2']]);
  const b = seatPlayer('s3b-player', 'S3B00', (room, rp) => {
    room.mode = 'marathon';
    room.marathon = {
      startArticle: 'S3b start', duration: 300000, durationKey: '5m', endsAt: Date.now() + 300000,
      timerId: null, timerStarted: true, clockFallbackId: null,
      candidates: new Map([['s3b cand', { title: 'S3b cand',
        data: { hop1: new Set(['s3b nowhere']), hop2: new Set(), aliases: new Set(['s3b cand']) } }]]),
    };
    rp.path = ['S3b start'];
    rp.marathonState = { currentTarget: null, events: [], usedTitles: new Set() };
  });
  await s.handleAction('s3b-player', { type: 'mk_request_next' });
  const target = b.msgs.find(m => m.type === 'marathon_next_target');
  ok(`pick delivered a target (${target && target.target && target.target.title})`, !!(target && target.target));
  ok('pick: links of the current article ran high', allHigh(/^links:S3b start$/));
  ok('pick: computeDistance live-verification fan-out ran low', allLow(/^links:s3b mid /));

  // 3c. start_single with a manual pair: game_start waits on the redirect
  // resolution and the backlink guardrail (high); cacheDestination and the
  // origin distance launched after it are background (low).
  fake.links.set('S3c origin', [['S3c mid']]);
  const c = seatPlayer('s3c-player', null, null);
  const started = await s.handleAction('s3c-player',
    { type: 'start_single', name: 'Tester', mode: 'classic', origin: 'S3c origin', destination: 'S3c dest' });
  await until(() => c.msgs.some(m => m.type === 'distance_update'), 'start distance_update');
  ok(`start_single ok, game_start sent (${started && started.code})`, !!(started && started.ok) && c.msgs.some(m => m.type === 'game_start'));
  ok('start: redirect resolution + backlink guardrail ran high',
    allHigh(/^redirect:S3c (origin|dest)$/) && allHigh(/^backlinks:S3c dest\/15$/));
  ok('start: cacheDestination (aliases, hop1, hop2) + origin distance ran low',
    allLow(/^aliases:S3c dest$/) && allLow(/^backlinks:S3c dest\/500$/) &&
    allLow(/^backlinks:s3c dest bl \d\/200$/) && allLow(/^links:S3c origin$/));
}

// ── 4. No starvation ──
async function scenarioStarvation() {
  // Six background fetches queue first; then eight player-priority workers
  // each keep a fetch queued back to back, so a high waiter is always ahead.
  const lows = [];
  for (let i = 0; i < 6; i++) lows.push(s.getPageLinks(`S4 low ${i}`));
  let stop = false, n = 0;
  const workers = Array.from({ length: 8 }, (_, w) => hi(async () => {
    while (!stop) await s.getPageLinks(`S4 hi ${w} ${n++}`);
  }));
  const t0 = Date.now();
  // null if the stream had to be stopped first. With the guard, each low
  // waits ~WIKI_MAX_LOW_SKIPS+1 starts: ~3s here.
  const lowsDoneMs = await Promise.race([
    Promise.all(lows).then(() => Date.now() - t0),
    sleep(50 * Math.max(LATENCY_MS, 2 * s.WIKI_MIN_INTERVAL_MS)).then(() => null),
  ]);
  const highsDuring = startsOf(/^links:S4 hi /).length;
  stop = true;
  await Promise.all(workers);
  await Promise.all(lows);
  // While any background fetch was waiting, how many player-priority starts
  // in a row did the queue hand out?
  const seq = startsOf(/^links:S4 /);
  const lastLow = seq.map(x => /^links:S4 low /.test(x.key)).lastIndexOf(true);
  let run = 0, maxRun = 0;
  for (const x of seq.slice(0, lastLow + 1)) { run = x.high ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  ok(`all 6 background fetches finished while the stream kept running (${lowsDoneMs}ms, ${highsDuring} high starts meanwhile)`,
    lowsDoneMs !== null);
  ok(`at most WIKI_MAX_LOW_SKIPS=${s.WIKI_MAX_LOW_SKIPS} high starts in a row while background waited (max ${maxRun})`,
    maxRun <= s.WIKI_MAX_LOW_SKIPS);
}

// ── 6. Retries after a 429 keep their priority ──
async function scenarioRetry() {
  // 6a. A player-priority fetch is 429'd on its first attempt while
  // background work queues up behind it; the retry must still go first.
  fake.fail.set('links:S6 hi', 1);
  const p = hi(() => s.getPageLinks('S6 hi'));
  await sleep(10);
  const bg = [];
  for (let i = 0; i < 20; i++) bg.push(s.getPageLinks(`S6 low ${i}`));
  await p;
  await Promise.all(bg);
  const att = startsOf(/^links:S6 hi$/);
  const retryAt = fake.starts.indexOf(att[1]);
  const lowsAfterRetry = fake.starts.slice(retryAt).filter(x => /^links:S6 low /.test(x.key)).length;
  ok(`high fetch retried once after its 429 (${att.length} attempts)`, att.length === 2);
  ok('…and the retry ran high', att.length === 2 && att[0].high && att[1].high);
  ok(`…ahead of the queued background work (${lowsAfterRetry}/20 background fetches started after it)`, lowsAfterRetry >= 10);

  // 6b. A background fetch is 429'd; while it backs off (250-400ms), a
  // player-priority caller joins it. The retry must come back high.
  fake.fail.set('links:S6 x', 1);
  const lowX = s.getPageLinks('S6 x');
  await until(() => startsOf(/^links:S6 x$/).length === 1, 'first attempt of S6 x');
  await sleep(LATENCY_MS + 50); // its 429 has arrived; the backoff is running
  const joined = hi(() => s.getPageLinks('S6 x'));
  await Promise.all([lowX, joined]);
  const attX = startsOf(/^links:S6 x$/);
  ok(`background fetch retried after its 429 (${attX.length} attempts)`, attX.length === 2);
  ok('…first attempt low, retry high after a player joined during the backoff',
    attX.length === 2 && !attX[0].high && attX[1].high);
}

// ── 5. The gates are unchanged ──
async function scenarioGates() {
  // At 200ms the interval gate binds first (2-3 in flight). Slow answers
  // make the concurrency cap bind instead: every slot fills and the rest of
  // the burst waits for a release.
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push(s.getPageLinks(`S5 slow ${i}`));
  burst.push(hi(() => s.getPageLinks('S5 slow hi')));
  await Promise.all(burst);
  ok(`never more than WIKI_MAX_CONCURRENT=${s.WIKI_MAX_CONCURRENT} in flight, reached by the slow burst (max ${fake.maxInFlight}, ${fake.starts.length} requests)`,
    fake.maxInFlight === s.WIKI_MAX_CONCURRENT);
  // Spacing is asserted on the queue's start stamps. The stub's own arrival
  // stamps trail them by a microtask, which can tick into the next ms, or by a
  // GC pause (one run read a 94ms gap), so those are only reported.
  let minGap = Infinity, minArrivalGap = Infinity;
  for (let i = 1; i < fake.starts.length; i++) {
    minGap = Math.min(minGap, fake.starts[i].queueT - fake.starts[i - 1].queueT);
    minArrivalGap = Math.min(minArrivalGap, fake.starts[i].t - fake.starts[i - 1].t);
  }
  ok(`starts spaced ≥ WIKI_MIN_INTERVAL_MS=${s.WIKI_MIN_INTERVAL_MS} (min ${minGap}ms; ${minArrivalGap}ms between stub arrivals)`,
    minGap >= s.WIKI_MIN_INTERVAL_MS);
}

(async () => {
  const shown = path.relative(process.cwd(), serverPath);
  say(`Wikipedia queue priority @ ${shown.startsWith('..') ? serverPath : shown} (stub latency ${LATENCY_MS}ms)`);

  say('── 1. Click check behind 30 queued background fetches ──');
  const r1 = await scenarioLatency();
  say(`  click check: ${r1.ms}ms; background fetches started before it finished: ${r1.lowsFirst}/30`);
  if (!prioritized) {
    say('  (no withWikiPriority in this server: plain FIFO, scenario 1 only)');
    process.exit(0);
  }
  ok('move judged legal', r1.legal === true);
  ok('click check ran high (redirect + links)', r1.clickReqs.length === 2 && r1.clickReqs.every(x => x.high));
  ok(`finished after a few slots, not 30 (${r1.lowsFirst} background starts first)`, r1.lowsFirst <= 10);

  say('── 1b. Every slot busy: the click check keeps its slot between steps ──');
  const r1b = await scenarioHandOff();
  say(`  click check: ${r1b.ms}ms`);
  ok('setup: its first request ran with every slot busy', r1b.allBusy);
  ok(`its second request took the slot its first freed (${r1b.lowsBetween} background starts in between)`, r1b.lowsBetween === 0);
  ok('move judged legal', r1b.legal === true);

  say('── 2. Promotion: click check joins a queued background getPageLinks(X) ──');
  const r2 = await scenarioPromotion();
  say(`  click check: ${r2.ms}ms for 3 pages of X`);
  ok('X was still queued when the click check joined', r2.startedBeforeJoin === 0);
  ok(`X's first page started next (${r2.startsAhead} other starts first)`, r2.startsAhead <= 1);
  ok('X fetched once for both callers, all 3 pages high', r2.xPages.length === 3 && r2.xPages.every(x => x.high));
  ok('move judged legal', r2.legal === true);

  say('── 3. Background work launched from player-facing code stays low ──');
  await scenarioBackground();

  say('── 4. Background work is not starved ──');
  await scenarioStarvation();

  say('── 6. Retries after a 429 keep their priority ──');
  await scenarioRetry();

  say('── 5. Concurrency + interval gates (every request in this run) ──');
  await scenarioGates();

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
