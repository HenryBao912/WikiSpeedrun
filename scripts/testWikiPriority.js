#!/usr/bin/env node
// Wikipedia request-queue priority tests — run: node scripts/testWikiPriority.js
// No network, deterministic: https.get is stubbed for Wikipedia hosts with a
// fake that answers after a fixed delay (--latency, default 200ms) with JSON
// shaped like the real API, or with a 429 when a test asks for one (carrying
// Retry-After in 1c, as live Wikipedia's do). ~50s.
//
// Guards the Oct 18 2026 fix. Every server-side Wikipedia call shares one
// queue (WIKI_MAX_CONCURRENT in flight, WIKI_MIN_INTERVAL_MS between starts),
// and the click check a player waits on used to sit FIFO behind background
// work (cacheDestination, computeDistance's live verification). Oct 18 prod:
// 1.45% of /action took >3s (p99 10s, max 33s), tracking 429 counts. Now
// player-facing calls go first. That removes a click check's wait for a slot,
// not the backoff after its own 429s; 1c measures the two apart.
//
//   1. A click check queued behind 30 background fetches finishes after a
//      few slots, not after all 30. 1b: with every slot busy, its second
//      request takes the slot its first one freed (no background fetch slips
//      in between the two). 1c: the same click check with one 429 per
//      request, its time split into queue wait, backoff and Wikipedia. 1d: a
//      marathon pick whose candidate no hop set settles, so it verifies live.
//   2. Promotion: a queued background getPageLinks(X) jumps the queue when a
//      click check that needs X joins it, and so do its later pages.
//   3. Every player-facing span runs high, and what it launches without
//      awaiting stays low: navigate in classic, marathon and tri; the
//      marathon pick (mk_request_next, mk_skip), whose live verification is
//      high up to the pick's budget and background past it; start_single
//      (classic, marathon) and start_daily; /validate-dest.
//   4. Pump order: waiters start in arrival order within each class, and
//      background work completes under a steady stream of player requests.
//   5. Concurrency never exceeds WIKI_MAX_CONCURRENT, even for a player
//      request queued while every slot is busy, and starts are spaced by
//      WIKI_MIN_INTERVAL_MS, asserted from the stub's own records.
//   6. A retry after a 429 keeps the request's priority, including a request
//      promoted while it was backing off.
//
// Like testWikiApi.js, this reaches internals through a patched require.
// --server <path/to/server.js> runs against another checkout, e.g. the code
// from before this change, for before/after numbers. A server without
// withWikiPriority runs the latency scenarios (1, 1c, 1d) only, unprioritized.

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
// and, when the response goes back, `end` and its status.
const fake = {
  starts: [],
  inFlight: 0,
  maxInFlight: 0,
  links: new Map(),  // title -> pages of outgoing link titles (default: one page)
  fail: new Map(),   // request key -> how many 429s to answer before succeeding
  retryAfter: null,  // seconds; when set, those 429s carry a Retry-After header
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
  // Titles with "slow" in them answer at 5× latency (1b and 5a fill every slot).
  setTimeout(() => {
    fake.inFlight--;
    rec.end = Date.now();
    const res = new EventEmitter();
    const fails = fake.fail.get(c.key) || 0;
    if (fails > 0) fake.fail.set(c.key, fails - 1);
    rec.status = res.statusCode = fails > 0 ? 429 : 200;
    res.headers = fails > 0 && fake.retryAfter != null ? { 'retry-after': String(fake.retryAfter) } : {};
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
  'isLegalMove', 'getPageLinks', 'handleAction', 'rooms', 'players', 'initRoom', 'server',
  'cacheSet', 'cacheKey', 'redirectCache', 'withWikiPriority', 'wikiPriority',
  'WIKI_MAX_CONCURRENT', 'WIKI_MIN_INTERVAL_MS', 'WIKI_MAX_LOW_SKIPS',
];
const patched = src.replace(/^module\.exports = \{/m, 'module.exports = {\n' +
  internals.map(n => `  ${n}: typeof ${n} === 'undefined' ? undefined : ${n},`).join('\n') +
  '\n  lastWikiStart: () => wikiLastStart,' +
  // Nothing in flight, queued, or waiting for a cacheDestination slot.
  '\n  wikiIdle: () => !wikiInFlight && !wikiWaiters.length && !cacheDestInflight && !cacheDestQueue.length,');
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

// A marathon player mid-round, every candidate already warmed. Candidates are
// [title, hop1 titles]: no hop2, no aliases but the title itself.
function seatMarathon(playerId, roomCode, startArticle, candidates, currentTarget = null) {
  const norm = t => t.replace(/_/g, ' ').toLowerCase();
  return seatPlayer(playerId, roomCode, (room, rp) => {
    room.mode = 'marathon';
    room.marathon = {
      startArticle, duration: 300000, durationKey: '5m', endsAt: Date.now() + 300000,
      timerId: null, timerStarted: true, clockFallbackId: null,
      candidates: new Map(candidates.map(([title, hop1]) => [norm(title), { title,
        data: { hop1: new Set(hop1.map(norm)), hop2: new Set(), aliases: new Set([norm(title)]) } }])),
    };
    rp.path = [startArticle];
    rp.marathonState = { currentTarget, events: [], usedTitles: new Set() };
  });
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

// ── 1c. The click check under 429s: queue wait vs backoff ──
async function scenario429() {
  // Scenario 1's click check behind 30 background fetches, but each of its
  // two requests is 429'd once with Retry-After: 1, as live Wikipedia does
  // under load. wikiAPI waits that out (the larger of Retry-After, clamped to
  // 5s, and its own backoff) before the retry goes back into the queue, so
  // priority can only shorten the queue part. Time per part: Wikipedia is the
  // stub's own response times, backoff is Retry-After per 429, queue wait is
  // the rest.
  const RETRY_AFTER_S = 1;
  const bg = [];
  for (let i = 0; i < 30; i++) bg.push(s.getPageLinks(`S1c low ${i}`));
  fake.links.set('S1c from', [['S1c target']]);
  fake.retryAfter = RETRY_AFTER_S;
  fake.fail.set('redirect:S1c from', 1);
  fake.fail.set('links:S1c from', 1);
  const t0 = Date.now();
  const legal = await hi(() => s.isLegalMove('S1c from', 'S1c target'));
  const ms = Date.now() - t0;
  fake.retryAfter = null;
  await Promise.all(bg);
  const att = startsOf(/^(redirect|links):S1c from$/);
  const throttled = att.filter(x => x.status === 429);
  const wiki = att.reduce((sum, x) => sum + (x.end - x.t), 0);
  const backoff = throttled.length * RETRY_AFTER_S * 1000;
  // From each 429 to its retry's start: the backoff plus the retry's wait.
  const gaps = throttled.map(x => att.find(y => y.key === x.key && y.t > x.t).t - x.end);
  return { legal, ms, attempts: att.length, throttled: throttled.length, wiki, backoff,
    queue: ms - wiki - backoff, gaps, retryAfterMs: RETRY_AFTER_S * 1000 };
}

// ── 1d. A marathon pick that has to verify live, behind background work ──
async function scenarioPick() {
  // The only warmed candidate's hop sets miss all 12 of the current article's
  // outlinks, so computeDistance verifies live: 12 getPageLinks (a batch of
  // 10, then 2), all inside the pick's budget. The player waits on all of it
  // with the round clock running.
  fake.links.set('S1d start', [Array.from({ length: 12 }, (_, i) => `S1d mid ${i}`)]);
  const p = seatMarathon('s1d-player', 'S1D00', 'S1d start', [['S1d cand', ['S1d nowhere']]]);
  const bg = [];
  for (let i = 0; i < 30; i++) bg.push(s.getPageLinks(`S1d low ${i}`));
  const t0 = Date.now();
  await s.handleAction('s1d-player', { type: 'mk_request_next' });
  const tDone = Date.now();
  await Promise.all(bg);
  const target = p.msgs.find(m => m.type === 'marathon_next_target');
  return {
    ms: tDone - t0,
    lowsFirst: startsOf(/^links:S1d low /).filter(x => x.t <= tDone).length,
    fan: startsOf(/^links:s1d mid /),
    delivered: !!(target && target.target),
  };
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

// ── 3. Player-facing spans run high; what they launch stays low ──
async function scenarioSpans() {
  const prio = re => startsOf(re).map(x => x.high);
  const allLow = re => prio(re).length > 0 && prio(re).every(h => !h);
  const allHigh = re => prio(re).length > 0 && prio(re).every(h => h);
  const settled = label => until(s.wikiIdle, label);

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
  await settled('classic navigate settled');
  ok(`navigate accepted (${JSON.stringify(r)})`, r && r.ok === true);
  ok('navigate: move check + win check ran high (redirect + links of from, redirect of target)',
    allHigh(/^redirect:S3a from$/) && allHigh(/^links:S3a from$/) && allHigh(/^redirect:S3a target$/));
  ok('navigate: the distance it fires off ran low (links of target + live-verification fan-out)',
    allLow(/^links:S3a target$/) && allLow(/^links:s3a mid /));

  // 3b. navigate (marathon, a target set): the move check and the hit lookup
  // (handleMarathonNavigate's resolveRedirect) are awaited (high); the
  // outgoing-links prefetch for the next pick is not (low).
  fake.links.set('S3b from', [['S3b next']]);
  seatMarathon('s3b-player', 'S3B00', 'S3b from', [],
    { title: 'S3b target', hops: 2, score: 25, shownAtStep: 0 });
  const rb = await s.handleAction('s3b-player', { type: 'navigate', article: 'S3b next' });
  await settled('marathon navigate prefetch');
  ok(`marathon navigate accepted (${JSON.stringify(rb)})`, rb && rb.ok === true);
  ok('marathon navigate: move check + hit lookup ran high (redirect + links of from, redirect of next)',
    allHigh(/^redirect:S3b from$/) && allHigh(/^links:S3b from$/) && allHigh(/^redirect:S3b next$/));
  ok('marathon navigate: the links prefetch it fires off ran low', allLow(/^links:S3b next$/));

  // 3c. navigate (tri): the same awaited checks (high); the distances to the
  // two unvisited targets it fires off are not (low), fan-out included.
  fake.links.set('S3c from', [['S3c next']]);
  fake.links.set('S3c next', [['S3c mid 1', 'S3c mid 2']]);
  const nowhere = t => ({ hop1: new Set(['s3c nowhere']), hop2: new Set(), aliases: new Set([t.toLowerCase()]) });
  const c = seatPlayer('s3c-player', 'S3C00', (room, rp) => {
    room.mode = 'tri';
    room.triple = { targets: ['S3c from', 'S3c t1', 'S3c t2'] };
    room.triDestData = { 'S3c t1': nowhere('S3c t1'), 'S3c t2': nowhere('S3c t2') };
    rp.path = ['S3c from'];
    rp.visited = ['S3c from'];
    rp.distances = [];
  });
  const rc = await s.handleAction('s3c-player', { type: 'navigate', article: 'S3c next' });
  await until(() => c.rp.triDistances && Object.keys(c.rp.triDistances).length === 2, 'tri distances');
  await settled('tri navigate settled');
  ok(`tri navigate accepted (${JSON.stringify(rc)})`, rc && rc.ok === true);
  ok('tri navigate: move check + win check ran high (redirect + links of from, redirect of next)',
    allHigh(/^redirect:S3c from$/) && allHigh(/^links:S3c from$/) && allHigh(/^redirect:S3c next$/));
  ok('tri navigate: the distances it fires off ran low (links of next + live-verification fan-out)',
    allLow(/^links:S3c next$/) && allLow(/^links:s3c mid /));

  // 3d. mk_request_next: the pick is awaited (high), and so is the live
  // verification inside it while the pick's budget lasts (2 fetches here).
  fake.links.set('S3d start', [['S3d mid 1', 'S3d mid 2']]);
  const d = seatMarathon('s3d-player', 'S3D00', 'S3d start', [['S3d cand', ['S3d nowhere']]]);
  await s.handleAction('s3d-player', { type: 'mk_request_next' });
  const target = d.msgs.find(m => m.type === 'marathon_next_target');
  ok(`pick delivered a target (${target && target.target && target.target.title})`, !!(target && target.target));
  ok('pick: links of the current article ran high', allHigh(/^links:S3d start$/));
  ok('pick: its live verification ran high, inside the pick\'s budget', allHigh(/^links:s3d mid /));

  // 3e. mk_skip: records the skip, then the same pick (high).
  fake.links.set('S3e start', [['S3e mid']]);
  const e = seatMarathon('s3e-player', 'S3E00', 'S3e start', [['S3e cand', ['S3e mid']]],
    { title: 'S3e skipped', hops: 2, score: 25, shownAtStep: 0 });
  await s.handleAction('s3e-player', { type: 'mk_skip' });
  const next = e.msgs.find(m => m.type === 'marathon_next_target');
  ok(`skip recorded, next target delivered (${next && next.target && next.target.title})`,
    e.rp.marathonState.events.some(x => x.kind === 'skip') && !!(next && next.target));
  ok('mk_skip: the pick\'s links of the current article ran high', allHigh(/^links:S3e start$/));

  // 3f. A pick whose live verification outruns its budget: 22 outlinks and
  // two candidates no hop set settles. The first candidate's 20 fetches use
  // up the budget (high); the second fetches the other 2 as background.
  const mids = Array.from({ length: 22 }, (_, i) => `S3f mid ${i}`);
  fake.links.set('S3f start', [mids]);
  seatMarathon('s3f-player', 'S3F00', 'S3f start',
    [['S3f cand 1', ['S3f nowhere']], ['S3f cand 2', ['S3f nowhere']]]);
  await s.handleAction('s3f-player', { type: 'mk_request_next' });
  const fan = new Map(startsOf(/^links:s3f mid /).map(x => [x.key, x.high]));
  const fanHigh = list => list.map(t => fan.get(`links:${t.toLowerCase()}`));
  ok(`pick past its budget: first 20 live-verification fetches ran high, last 2 low (${[...fan.values()].filter(Boolean).length}/${fan.size} high)`,
    fan.size === 22 && fanHigh(mids.slice(0, 20)).every(h => h === true) && fanHigh(mids.slice(20)).every(h => h === false));

  // 3g. start_single with a manual pair: game_start waits on the redirect
  // resolution and the backlink guardrail (high); cacheDestination and the
  // origin distance launched after it are background (low).
  fake.links.set('S3g origin', [['S3g mid']]);
  const g = seatPlayer('s3g-player', null, null);
  const started = await s.handleAction('s3g-player',
    { type: 'start_single', name: 'Tester', mode: 'classic', origin: 'S3g origin', destination: 'S3g dest' });
  await until(() => g.msgs.some(m => m.type === 'distance_update'), 'start distance_update');
  await settled('classic start settled');
  ok(`start_single ok, game_start sent (${started && started.code})`, !!(started && started.ok) && g.msgs.some(m => m.type === 'game_start'));
  ok('start: redirect resolution + backlink guardrail ran high',
    allHigh(/^redirect:S3g (origin|dest)$/) && allHigh(/^backlinks:S3g dest\/15$/));
  ok('start: cacheDestination (aliases, hop1, hop2) + origin distance ran low',
    allLow(/^aliases:S3g dest$/) && allLow(/^backlinks:S3g dest\/500$/) &&
    allLow(/^backlinks:s3g dest bl \d\/200$/) && allLow(/^links:S3g origin$/));

  // 3h. start_daily: the same awaited checks for today's pair (high). The
  // daily warm it fires first (destination backlinks + origin links, for the
  // leaderboard's fake paths), cacheDestination and the origin distance stay
  // background. Runs before 3i, whose candidates come from the same pool.
  const daily = s.getDailyChallenge();
  const sp = t => t.replace(/_/g, ' ');
  const awaited = new Set([`redirect:${sp(daily.origin)}`, `redirect:${sp(daily.destination)}`,
    `backlinks:${sp(daily.destination)}/15`]);
  const h = seatPlayer('s3h-player', null, null);
  const fromDaily = fake.starts.length;
  const startedDaily = await s.handleAction('s3h-player', { type: 'start_daily', name: 'Tester' });
  await until(() => h.msgs.some(m => m.type === 'distance_update'), 'daily distance_update');
  await settled('daily start settled');
  const dailyReqs = fake.starts.slice(fromDaily);
  const rest = dailyReqs.filter(x => !awaited.has(x.key));
  ok(`start_daily ok, game_start sent (${daily.origin} → ${daily.destination})`,
    !!(startedDaily && startedDaily.ok) && h.msgs.some(m => m.type === 'game_start'));
  ok('start_daily: redirect resolution + backlink guardrail ran high',
    [...awaited].every(k => dailyReqs.some(x => x.key === k)) && dailyReqs.filter(x => awaited.has(x.key)).every(x => x.high));
  ok(`start_daily: the other ${rest.length} ran low, the daily warm's origin links + destination backlinks included`,
    rest.some(x => x.key === `links:${sp(daily.origin)}`) && rest.some(x => x.key === `backlinks:${sp(daily.destination)}/500`) &&
    rest.every(x => !x.high));

  // 3i. start_single (marathon): nothing on the way to game_start is a
  // player request; the candidate warm-up (five raced, the rest in batches of
  // three) is all background. Once warmMarathonCandidates has its first
  // batch going, the round is stopped so the rest can't spill into later
  // scenarios.
  const m = seatPlayer('s3i-player', null, null);
  const fromMarathon = fake.starts.length;
  const mStarted = await s.handleAction('s3i-player',
    { type: 'start_single', name: 'Tester', mode: 'marathon', duration: '3m' });
  await until(() => m.msgs.some(x => x.type === 'game_start'), 'marathon game_start');
  const round = s.rooms.get(mStarted.code);
  round.started = false;
  await settled('marathon warm-up drained');
  const titles = [...round.marathon.candidates.values()].map(x => x.title);
  const mReqs = fake.starts.slice(fromMarathon);
  const warmed = list => list.some(t => mReqs.some(x => x.key === `aliases:${sp(t)}`));
  ok(`start_single (marathon) ok, game_start sent (${mStarted && mStarted.code})`,
    !!(mStarted && mStarted.ok) && m.msgs.some(x => x.type === 'game_start'));
  ok(`marathon start: all ${mReqs.length} warm-up requests ran low (the raced five + warmMarathonCandidates' first batch)`,
    warmed(titles.slice(0, 5)) && warmed(titles.slice(5, 8)) && mReqs.every(x => !x.high));

  // 3j. /validate-dest: the word box waits on its backlink count (high).
  const answer = await new Promise(resolve => {
    const res = {
      setHeader() {},
      writeHead(code) { this.code = code; },
      end(body) { resolve({ code: this.code, body: JSON.parse(body) }); },
    };
    s.server.emit('request', { url: '/validate-dest?title=S3j_dest&lang=en', method: 'GET', headers: {} }, res);
  });
  ok(`/validate-dest answered (${answer.code} ${JSON.stringify(answer.body)})`, answer.code === 200 && answer.body.sparse === false);
  ok('/validate-dest: redirect + backlink count ran high', allHigh(/^redirect:S3j dest$/) && allHigh(/^backlinks:S3j dest\/15$/));
}

// ── 4a. Arrival order within each class ──
async function scenarioArrivalOrder() {
  // Ten background fetches, then three player requests, all queued at once.
  // Each class must start in the order it arrived: a pump that took the
  // newest player waiter would let a later click check overtake an earlier
  // one. Then three background fetches with nothing else queued.
  const lows = Array.from({ length: 10 }, (_, i) => `S4a low ${i}`);
  const highs = ['S4a hi 0', 'S4a hi 1', 'S4a hi 2'];
  await Promise.all([...lows.map(t => s.getPageLinks(t)), ...highs.map(t => hi(() => s.getPageLinks(t)))]);
  const solo = ['S4a solo 0', 'S4a solo 1', 'S4a solo 2'];
  await Promise.all(solo.map(t => s.getPageLinks(t)));
  const order = re => startsOf(re).map(x => x.key.slice('links:'.length));
  const same = (a, b) => a.join('|') === b.join('|');
  ok(`player requests started in arrival order (${order(/^links:S4a hi /).join(', ')})`, same(order(/^links:S4a hi /), highs));
  ok('the background fetches queued ahead of them started in arrival order', same(order(/^links:S4a low /), lows));
  ok('background fetches queued alone started in arrival order', same(order(/^links:S4a solo /), solo));
}

// ── 4b. No starvation ──
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

// ── 5a. A player request queued while every slot is busy ──
async function scenarioFullSlots() {
  // Four slow background fetches fill every slot and two more wait; then a
  // slow player request arrives. Priority may put it first in line, never
  // past the cap: it starts when the first slot frees, ahead of the two.
  const from = fake.starts.length;
  const bg = [];
  for (let i = 0; i < 6; i++) bg.push(s.getPageLinks(`S5a slow ${i}`));
  await until(() => fake.inFlight === s.WIKI_MAX_CONCURRENT, 'every slot busy');
  await Promise.all([...bg, hi(() => s.getPageLinks('S5a slow hi'))]);
  const run = fake.starts.slice(from);
  const h = run.find(x => x.key === 'links:S5a slow hi');
  const firstEnd = Math.min(...run.filter(x => x !== h).map(x => x.end));
  const peak = Math.max(...run.map(x => x.inFlight));
  ok(`still WIKI_MAX_CONCURRENT=${s.WIKI_MAX_CONCURRENT} in flight at most (peak ${peak}, the player request started with ${h.inFlight})`,
    peak === s.WIKI_MAX_CONCURRENT);
  ok(`the player request waited for a release, then took that slot first (started ${h.t - firstEnd}ms after it)`,
    h.t >= firstEnd && run.find(x => x.t >= firstEnd) === h);
}

// ── 5b. The gates are unchanged ──
async function scenarioGates() {
  // At 200ms the interval gate binds first (2-3 in flight). Slow answers
  // make the concurrency cap bind instead: every slot fills and the rest of
  // the burst waits for a release.
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push(s.getPageLinks(`S5 slow ${i}`));
  burst.push(hi(() => s.getPageLinks('S5 slow hi')));
  await Promise.all(burst);
  ok(`never more than WIKI_MAX_CONCURRENT=${s.WIKI_MAX_CONCURRENT} in flight, reached by the slow bursts (max ${fake.maxInFlight}, ${fake.starts.length} requests)`,
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
  // The latency scenarios also run against a server without priority, for
  // its numbers; only a server with priority is held to the checks.
  const check = (label, cond) => { if (prioritized) ok(label, cond); };

  say('── 1. Click check behind 30 queued background fetches ──');
  const r1 = await scenarioLatency();
  say(`  click check: ${r1.ms}ms; background fetches started before it finished: ${r1.lowsFirst}/30`);
  check('move judged legal', r1.legal === true);
  check('click check ran high (redirect + links)', r1.clickReqs.length === 2 && r1.clickReqs.every(x => x.high));
  check(`finished after a few slots, not 30 (${r1.lowsFirst} background starts first)`, r1.lowsFirst <= 10);

  if (prioritized) {
    say('── 1b. Every slot busy: the click check keeps its slot between steps ──');
    const r1b = await scenarioHandOff();
    say(`  click check: ${r1b.ms}ms`);
    ok('setup: its first request ran with every slot busy', r1b.allBusy);
    ok(`its second request took the slot its first freed (${r1b.lowsBetween} background starts in between)`, r1b.lowsBetween === 0);
    ok('move judged legal', r1b.legal === true);
  }

  say('── 1c. The same click check with a 429 (Retry-After: 1) on each of its requests ──');
  const r1c = await scenario429();
  say(`  click check: ${r1c.ms}ms = ${r1c.queue}ms waiting for a slot + ${r1c.backoff}ms backoff (${r1c.throttled} × Retry-After ${r1c.retryAfterMs / 1000}s) + ${r1c.wiki}ms Wikipedia`);
  check(`move judged legal after ${r1c.throttled} 429s (${r1c.attempts} attempts)`, r1c.legal === true && r1c.attempts === 4 && r1c.throttled === 2);
  check(`each retry waited out Retry-After before it started (${r1c.gaps.join(', ')}ms after its 429)`,
    r1c.gaps.length === 2 && r1c.gaps.every(g => g >= r1c.retryAfterMs - 10));
  check(`queue wait a few slots, not the 30 fetches ahead (${r1c.queue}ms ≤ ${r1c.attempts * 2 * s.WIKI_MIN_INTERVAL_MS}ms)`,
    r1c.queue <= r1c.attempts * 2 * s.WIKI_MIN_INTERVAL_MS);

  say('── 1d. Marathon pick that must verify live, behind 30 queued background fetches ──');
  const r1d = await scenarioPick();
  say(`  pick: ${r1d.ms}ms; background fetches started before it finished: ${r1d.lowsFirst}/30; live verification: ${r1d.fan.length} fetches, ${r1d.fan.filter(x => x.high).length} high`);
  check('pick delivered a target', r1d.delivered);
  check('its live verification ran high (all 12 inside the pick\'s budget)', r1d.fan.length === 12 && r1d.fan.every(x => x.high));
  check(`finished after a few slots, not 30 (${r1d.lowsFirst} background starts first)`, r1d.lowsFirst <= 10);

  if (!prioritized) {
    say('  (no withWikiPriority in this server: plain FIFO, latency scenarios only)');
    process.exit(0);
  }

  say('── 2. Promotion: click check joins a queued background getPageLinks(X) ──');
  const r2 = await scenarioPromotion();
  say(`  click check: ${r2.ms}ms for 3 pages of X`);
  ok('X was still queued when the click check joined', r2.startedBeforeJoin === 0);
  ok(`X's first page started next (${r2.startsAhead} other starts first)`, r2.startsAhead <= 1);
  ok('X fetched once for both callers, all 3 pages high', r2.xPages.length === 3 && r2.xPages.every(x => x.high));
  ok('move judged legal', r2.legal === true);

  say('── 3. Player-facing spans run high; what they launch stays low ──');
  await scenarioSpans();

  say('── 4. Pump order: arrival order within each class, no starvation ──');
  await scenarioArrivalOrder();
  await scenarioStarvation();

  say('── 6. Retries after a 429 keep their priority ──');
  await scenarioRetry();

  say('── 5. Concurrency + interval gates (5b: every request in this run) ──');
  await scenarioFullSlots();
  await scenarioGates();

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
