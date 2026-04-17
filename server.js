const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── Game State ───
const rooms = new Map();
const players = new Map(); // playerId -> { res (SSE), roomCode, name }

// Max length for a Wikipedia article title. The API docs cap at 255 bytes;
// anything longer is definitely malicious/garbage.
const MAX_ARTICLE_LEN = 255;

// Validate a user-supplied article name. Wikipedia allows almost any Unicode,
// so we can't whitelist characters — but we can bound length and reject
// control chars / pipes / brackets that break wiki-syntax and API params.
function isValidArticle(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > MAX_ARTICLE_LEN) return false;
  // Reject control chars and separators that would break API URL params
  if (/[\x00-\x1f\x7f|#<>\[\]{}]/.test(s)) return false;
  return true;
}

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
}

function generatePlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Random article fetching from Wikipedia ───

// Quick title-based filter (no API call needed)
function isBadTitle(title) {
  const lower = title.toLowerCase().replace(/_/g, ' ');
  // Lists, indexes, outlines, drafts
  if (/^(list of|lists of|index of|outline of|draft:|wikipedia:|template:|category:|portal:|module:|wikipedia)/.test(lower)) return true;
  if (lower === 'wikipedia') return true;
  // Disambiguation and parenthetical qualifiers — these are hard to reach via links
  // e.g. "Mario Bros. (Game & Watch)", "Paris (Texas)", "Mercury (planet)"
  if (lower.includes('(')) return true;
  // Chemical formulas like C11H15NO2, C2H6O, etc.
  if (/^c\d+h\d+/i.test(title)) return true;
  // Pure numbers or dates like "1945" or "1800s"
  if (/^\d{3,4}(s)?$/.test(title)) return true;
  if (/^\d+(st|nd|rd|th)_century/.test(lower)) return true;
  // Very short titles (1-2 chars) — usually abbreviations
  if (title.replace(/_/g, '').length <= 2) return true;
  // Titles longer than 3 words — tend to be obscure or overly specific
  if (lower.split(/\s+/).length > 3) return true;
  // ISO codes, technical strings with mostly digits/special chars
  if (/^[A-Z]{1,3}-?\d+/.test(title)) return true;
  // Non-English titles — contain accented/non-ASCII characters
  if (/[^\x00-\x7F]/.test(title)) return true;
  // Titles with periods (F.C., U.S., etc.) — often obscure sports/orgs
  if (title.includes('.')) return true;
  return false;
}

// Validate articles via API: check they're real content pages (not disambig/stubs)
// Biographies get a stricter threshold — only very famous people are fun to play with
async function validateArticles(titles) {
  if (titles.length === 0) return [];
  try {
    const params = {
      action: 'query',
      titles: titles.join('|'),
      prop: 'pageprops|info|categories',
      ppprop: 'disambiguation',
      inprop: 'length',
      cllimit: '50',
    };
    const data = await wikiAPI(params);
    const pages = data.query?.pages || {};
    const good = [];
    for (const page of Object.values(pages)) {
      if (!page || page.missing !== undefined) continue;
      // Skip disambiguation pages
      if (page.pageprops && 'disambiguation' in page.pageprops) continue;

      // Detect biographies — check categories AND title pattern
      const cats = (page.categories || []).map(c => c.title.toLowerCase());
      const isBioByCat = cats.some(c =>
        c.includes('living people') ||
        c.includes('possibly living people') ||
        /\d{1,4} births/.test(c) ||
        /\d{1,4} deaths/.test(c) ||
        c.includes('biography') ||
        c.includes('actresses') ||
        c.includes('actors') ||
        c.includes('politicians') ||
        c.includes('singers') ||
        c.includes('footballers') ||
        c.includes('musicians')
      );
      // Title heuristic: "Firstname Lastname" pattern (2-3 capitalized words, no other stuff)
      const titleClean = page.title.replace(/_/g, ' ');
      const isBioByTitle = /^[A-Z][a-z]+ [A-Z][a-z]+( [A-Z][a-z]+)?$/.test(titleClean);

      const isBio = isBioByCat || isBioByTitle;

      if (isBio) {
        // Biographies need 100KB+ — only the most famous people (Obama, etc.)
        if (page.length && page.length < 100000) continue;
        good.push({ title: page.title.replace(/ /g, '_'), isBio: true });
      } else {
        // Normal articles: skip stubs under 5KB
        if (page.length && page.length < 5000) continue;
        good.push({ title: page.title.replace(/ /g, '_'), isBio: false });
      }
    }
    // Prefer non-bio articles — only allow ~1 in 3 to be a biography
    const nonBios = good.filter(g => !g.isBio).map(g => g.title);
    const bios = good.filter(g => g.isBio).map(g => g.title);
    // Shuffle bios so selection is random
    bios.sort(() => Math.random() - 0.5);
    const maxBios = Math.max(1, Math.floor(nonBios.length * 0.5));
    return [...nonBios, ...bios.slice(0, maxBios)];
  } catch (e) {
    console.error('Error validating articles:', e.message);
    return titles; // on error, return unfiltered
  }
}

// ─── Page views & difficulty filtering ───

// Fetch individual article view counts (for mid-range filtering)
function getPageViews(titles) {
  const today = new Date();
  const endDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const start = new Date(today);
  start.setDate(start.getDate() - 30);
  const startDate = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`;

  const promises = titles.map(title => {
    const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
    const apiUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodedTitle}/daily/${startDate}/${endDate}`;
    return new Promise((resolve) => {
      https.get(apiUrl, { headers: { 'User-Agent': 'WikiSpeedrun/1.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const total = (json.items || []).reduce((sum, d) => sum + (d.views || 0), 0);
            resolve({ title, views: total });
          } catch (e) { resolve({ title, views: 0 }); }
        });
      }).on('error', () => resolve({ title, views: 0 }));
    });
  });
  return Promise.all(promises);
}

// Fetch top viewed articles from Wikimedia (for easy/popular range)
// Returns array of { title, views } sorted by views desc
let topArticlesCache = null;
let topArticlesCacheTime = 0;
const TOP_CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getTopViewedArticles() {
  // Return cache if fresh
  if (topArticlesCache && (Date.now() - topArticlesCacheTime < TOP_CACHE_TTL)) {
    return topArticlesCache;
  }

  try {
    // Try multiple days back — yesterday's data may not be available yet
    let articles = [];
    for (let daysBack = 1; daysBack <= 3; daysBack++) {
      const date = new Date();
      date.setDate(date.getDate() - daysBack);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');

      const apiUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${d}`;

      try {
        const result = await new Promise((resolve, reject) => {
          https.get(apiUrl, { headers: { 'User-Agent': 'WikiSpeedrun/1.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
        });

        const dayArticles = (result.items?.[0]?.articles || []);
        if (dayArticles.length > 0) {
          articles = dayArticles;
          console.log(`[top-articles] Got data for ${y}-${m}-${d} (${dayArticles.length} articles)`);
          break;
        }
      } catch (e) {
        console.log(`[top-articles] No data for ${y}-${m}-${d}, trying older...`);
      }
    }

    const filtered = articles
      .filter(a => {
        const t = a.article;
        if (t === 'Main_Page' || t === 'Special:Search' || t.startsWith('Special:')) return false;
        if (t.startsWith('Wikipedia:') || t.startsWith('Portal:') || t.startsWith('Help:')) return false;
        if (isBadTitle(t)) return false;
        return true;
      })
      .filter(a => a.views >= 1000)
      .map(a => ({ title: a.article, views: a.views * 30 }));

    topArticlesCache = filtered;
    topArticlesCacheTime = Date.now();
    console.log(`[top-articles] Cached ${filtered.length} popular articles (1K+ daily views)`);
    return filtered;
  } catch (e) {
    console.error('Error fetching top articles:', e.message);
    return topArticlesCache || [];
  }
}

// Pick random articles from the top-viewed pool within a view range
async function pickFromTopArticles(count, viewRange) {
  const top = await getTopViewedArticles();
  if (top.length === 0) return [];

  // Filter to view range
  let pool = top;
  if (viewRange) {
    pool = top.filter(a => a.views >= viewRange[0] && a.views <= viewRange[1]);
  }
  if (pool.length < count) pool = top; // fallback to all top if range too narrow

  // Shuffle and pick extra candidates (validation may reject some)
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, Math.min(count * 5, shuffled.length)).map(a => a.title);

  // Validate (filter disambig/stubs) — try multiple rounds if needed
  const validated = await validateArticles(picked);
  if (validated.length >= count) return validated.slice(0, count);

  // If first batch wasn't enough, try more from the pool
  const remaining = shuffled.slice(count * 5, count * 10).map(a => a.title);
  if (remaining.length > 0) {
    const extra = await validateArticles(remaining);
    validated.push(...extra);
  }
  return validated.slice(0, count);
}

// Main article fetcher — uses different strategies based on view range
async function getGoodRandomArticles(count, viewRange) {
  const needed = count;

  // If no filter, use plain random
  if (!viewRange) {
    return await fetchRandomArticles(needed);
  }

  const [minViews, maxViews] = viewRange;

  // High views (easy/mid): pull from top-viewed articles
  // Threshold: if min views > 5K, use the top-viewed pool
  if (minViews >= 5000) {
    const fromTop = await pickFromTopArticles(needed, viewRange);
    if (fromTop.length >= needed) return fromTop;
    // Fallback: try random with filtering
  }

  // Mid or low range: use random articles + filter by views
  const good = [];
  let attempts = 0;
  const maxAttempts = 8;

  while (good.length < needed && attempts < maxAttempts) {
    attempts++;
    try {
      const params = {
        action: 'query',
        list: 'random',
        rnnamespace: '0',
        rnlimit: '20',
      };
      const data = await wikiAPI(params);
      const batch = (data.query?.random || [])
        .map(r => r.title.replace(/ /g, '_'))
        .filter(t => !isBadTitle(t));

      if (batch.length === 0) continue;
      const validated = await validateArticles(batch);
      if (validated.length === 0) continue;

      const viewData = await getPageViews(validated);
      for (const { title, views } of viewData) {
        if (good.length >= needed) break;
        const norm = normalizeArticle(title);
        if (views >= minViews && views <= maxViews && !good.some(g => normalizeArticle(g) === norm)) {
          good.push(title);
        }
      }
    } catch (e) {
      console.error('Error fetching random articles:', e.message);
    }
  }

  // If we still don't have enough, supplement from top articles (never use unfiltered random)
  if (good.length < needed) {
    const extra = await pickFromTopArticles(needed - good.length, null);
    good.push(...extra);
  }

  return good.slice(0, needed);
}

// Plain random articles (no view filtering) — extracted from old logic
async function fetchRandomArticles(count) {
  const good = [];
  let attempts = 0;
  while (good.length < count && attempts < 4) {
    attempts++;
    try {
      const params = {
        action: 'query',
        list: 'random',
        rnnamespace: '0',
        rnlimit: String(Math.min(20, count * 5)),
      };
      const data = await wikiAPI(params);
      const batch = (data.query?.random || [])
        .map(r => r.title.replace(/ /g, '_'))
        .filter(t => !isBadTitle(t));
      if (batch.length === 0) continue;
      const validated = await validateArticles(batch);
      for (const a of validated) {
        if (good.length < count && !good.some(g => normalizeArticle(g) === normalizeArticle(a))) good.push(a);
      }
    } catch (e) {
      console.error('Error fetching random articles:', e.message);
    }
  }
  return good;
}

async function getRandomPair(viewRange) {
  const articles = await getGoodRandomArticles(2, viewRange);
  // Ensure no duplicates
  if (articles.length >= 2 && normalizeArticle(articles[0]) !== normalizeArticle(articles[1])) {
    return { origin: articles[0], destination: articles[1] };
  }
  // Retry once if we got a duplicate
  const retry = await getGoodRandomArticles(2, viewRange);
  if (retry.length >= 2 && normalizeArticle(retry[0]) !== normalizeArticle(retry[1])) {
    return { origin: retry[0], destination: retry[1] };
  }
  return { origin: 'Pizza', destination: 'Moon' };
}

async function getRandomTriple(viewRange) {
  const articles = await getGoodRandomArticles(3, viewRange);
  // Ensure all 3 are unique
  const norms = articles.map(a => normalizeArticle(a));
  const unique = norms.length === 3 && new Set(norms).size === 3;
  if (unique) {
    return { targets: [articles[0], articles[1], articles[2]] };
  }
  // Retry once
  const retry = await getGoodRandomArticles(3, viewRange);
  const rNorms = retry.map(a => normalizeArticle(a));
  if (rNorms.length === 3 && new Set(rNorms).size === 3) {
    return { targets: [retry[0], retry[1], retry[2]] };
  }
  return { targets: ['Moon', 'Dinosaur', 'Jazz'] };
}

function normalizeArticle(name) {
  return (name || '').replace(/_/g, ' ').toLowerCase();
}

// Resolve Wikipedia redirects to canonical title
async function resolveRedirect(title) {
  try {
    const data = await wikiAPI({ action: 'query', titles: title.replace(/ /g, '_'), redirects: '1' });
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0];
    if (page && !page.missing) return page.title.replace(/ /g, '_');
    return title;
  } catch (e) {
    return title;
  }
}

// ─── Wikipedia API for distance calculation ───
// LRU-ish caches with size + TTL bounds. Long-running servers otherwise grow
// unbounded since every navigated article gets cached indefinitely.
const CACHE_MAX = 5000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const linkCache = new Map(); // title -> { value: Set, expires: number }
const backlinkCache = new Map(); // title -> { value: Set, expires: number }

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) { cache.delete(key); return undefined; }
  // Touch: move to end so recent keys survive eviction
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(cache, key, value) {
  if (cache.size >= CACHE_MAX) {
    // Evict oldest (first) key — Map iterates insertion order
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function wikiAPI(params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, format: 'json', origin: '*' });
    const reqUrl = `https://en.wikipedia.org/w/api.php?${qs}`;
    https.get(reqUrl, { headers: { 'User-Agent': 'WikiSpeedrun/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getPageLinks(title) {
  const norm = normalizeArticle(title);
  const cached = cacheGet(linkCache, norm);
  if (cached) return cached;
  const links = new Set();
  let plcontinue = null;
  try {
    do {
      const params = { action: 'query', titles: title.replace(/ /g, '_'), prop: 'links', pllimit: '500', plnamespace: '0' };
      if (plcontinue) params.plcontinue = plcontinue;
      const data = await wikiAPI(params);
      const pages = data.query?.pages || {};
      for (const page of Object.values(pages)) {
        if (page.links) page.links.forEach(l => links.add(normalizeArticle(l.title)));
      }
      plcontinue = data.continue?.plcontinue;
    } while (plcontinue);
  } catch (e) {
    console.error('Error fetching links for', title, e.message);
  }
  cacheSet(linkCache, norm, links);
  return links;
}

async function getBacklinks(title, limit = 500) {
  const norm = normalizeArticle(title);
  const cached = cacheGet(backlinkCache, norm);
  if (cached) return cached;
  const links = new Set();
  let blcontinue = null;
  try {
    do {
      const params = { action: 'query', list: 'backlinks', bltitle: title.replace(/ /g, '_'), bllimit: String(Math.min(limit - links.size, 500)), blnamespace: '0' };
      if (blcontinue) params.blcontinue = blcontinue;
      const data = await wikiAPI(params);
      if (data.query?.backlinks) data.query.backlinks.forEach(l => links.add(normalizeArticle(l.title)));
      blcontinue = data.continue?.blcontinue;
    } while (blcontinue && links.size < limit);
  } catch (e) {
    console.error('Error fetching backlinks for', title, e.message);
  }
  cacheSet(backlinkCache, norm, links);
  return links;
}

async function computeDistance(currentArticle, destination, destData) {
  const currentNorm = normalizeArticle(currentArticle);
  const destNorm = normalizeArticle(destination);

  if (currentNorm === destNorm) return 0;

  // Get outgoing links from current page
  const outLinks = await getPageLinks(currentArticle);

  // Distance 1: destination is directly linked from current page
  if (outLinks.has(destNorm)) return 1;

  // Distance 2: current -> X -> destination
  // Check if any outgoing link is in the 1-hop backlinks set
  for (const link of outLinks) {
    if (destData.hop1.has(link)) return 2;
  }

  // Distance 3: current -> X -> Y -> destination
  // First check pre-cached hop2 set (fast, covers most cases)
  for (const link of outLinks) {
    if (destData.hop2.has(link)) return 3;
  }

  // hop2 cache is sampled so may miss paths. Do a live verification:
  // Check outgoing links' outgoing links against hop1 (destination's backlinks).
  // Use cached links when available (free), only fetch uncached ones.
  // Prioritize already-cached links first, then fetch up to 20 uncached ones.
  const outArray = [...outLinks];
  const cached = [];
  const uncached = [];
  for (const link of outArray) {
    if (linkCache.has(normalizeArticle(link))) cached.push(link);
    else uncached.push(link);
  }

  // Check all cached ones first (instant, no API calls)
  for (const article of cached) {
    const middleLinks = linkCache.get(normalizeArticle(article));
    if (middleLinks) {
      for (const link of middleLinks) {
        if (destData.hop1.has(link)) return 3;
      }
    }
  }

  // Fetch up to 20 uncached in parallel batches
  const toFetch = uncached.slice(0, 20);
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(article => getPageLinks(article).catch(() => new Set()))
    );
    for (const middleLinks of results) {
      for (const link of middleLinks) {
        if (destData.hop1.has(link)) return 3;
      }
    }
  }

  // No proven 3-hop path found — genuinely far
  if (outLinks.size > 200) return 4;
  if (outLinks.size > 50) return 5;
  return 6;
}

// Pre-cache destination data when game starts
// Builds two sets:
//   hop1: articles that link directly to destination (1 hop away)
//   hop2: articles that link to a hop1 article (2 hops away)
// This makes distance checks 0-3 instant and 100% accurate (within cache limits)
async function cacheDestination(destination) {
  console.log(`[cache] Building distance cache for: ${destination}`);
  const start = Date.now();

  // hop1: direct backlinks to destination
  const hop1 = await getBacklinks(destination, 2000);
  console.log(`[cache] hop1: ${hop1.size} backlinks to ${destination}`);

  // hop2: backlinks to the hop1 articles
  // Fetching ALL hop1 backlinks would be too many API calls.
  // Sample up to 50 hop1 articles and fetch their backlinks.
  // Prioritize hop1 articles that are likely "hub" pages (common topics).
  const hop1Array = [...hop1];
  const hop1Sample = hop1Array.length <= 50
    ? hop1Array
    : hop1Array.sort(() => Math.random() - 0.5).slice(0, 50);

  const hop2 = new Set();
  // Fetch backlinks in parallel batches of 10
  for (let i = 0; i < hop1Sample.length; i += 10) {
    const batch = hop1Sample.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(article => getBacklinks(article, 200).catch(() => new Set()))
    );
    for (const backlinks of results) {
      for (const link of backlinks) {
        hop2.add(link);
      }
    }
  }
  // Remove hop1 articles from hop2 (they're already closer)
  for (const link of hop1) hop2.delete(link);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[cache] hop2: ${hop2.size} articles (sampled ${hop1Sample.length} hop1 nodes) in ${elapsed}s`);

  return { hop1, hop2 };
}

// ─── SSE helpers ───
function sendSSE(playerId, data) {
  const player = players.get(playerId);
  if (!player || !player.res || player.res.writableEnded) return;
  try {
    player.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    console.error('SSE write error for', playerId, e.message);
  }
}

function broadcastToRoom(roomCode, msg) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [pid] of room.players) {
    sendSSE(pid, msg);
  }
}

// ─── Game Logic ───
function initRoom(code, hostId, hostName) {
  return {
    host: hostId,
    players: new Map([[hostId, newPlayerState(hostName, 0)]]),
    mode: 'classic', // 'classic' or 'tri'
    pair: null,       // classic mode
    triple: null,     // tri mode
    started: false,
    startTime: null,
    winner: null,
    destData: null, // { hop1: Set, hop2: Set } for distance calc
    viewRange: null, // [minViews, maxViews] for difficulty filtering
    manualArticles: null, // { origin, destination } or { targets: [a,b,c] }
    giveUpVotes: new Set(), // set of playerIds who voted to give up
    singlePlayer: false, // true if room is single-player only
    colorIndex: 1, // next color index (host already took 0)
  };
}

// Player colors — assigned in join order per room
const PLAYER_COLORS = ['#7c6fad', '#5a9e8f', '#b07850', '#5a8ab5', '#a86060', '#8a6aaa', '#508f80', '#b08a55'];

function newPlayerState(name, roomColorIndex) {
  const color = PLAYER_COLORS[(roomColorIndex || 0) % PLAYER_COLORS.length];
  return {
    name,
    color,
    path: [],
    finished: false,
    finishTime: null,
    // Tri mode: which targets has this player visited
    visited: [],
  };
}

async function startGameForRoom(room, roomCode) {
  room.started = true;
  room.startTime = Date.now();
  room.winner = null;
  room.giveUpVotes.clear(); // Reset votes for new game
  const viewRange = room.viewRange || null;

  if (room.mode === 'classic') {
    // Use manual articles if set, otherwise generate random
    const ma = room.manualArticles || {};
    if (ma.origin && ma.destination) {
      room.pair = { origin: ma.origin, destination: ma.destination };
    } else if (ma.origin || ma.destination) {
      const randomPair = await getRandomPair(viewRange);
      room.pair = {
        origin: ma.origin || randomPair.origin,
        destination: ma.destination || randomPair.destination,
      };
    } else {
      room.pair = await getRandomPair(viewRange);
    }
    // Resolve redirects to canonical titles, keep originals for fallback matching
    const origOrigin = room.pair.origin;
    const origDest = room.pair.destination;
    room.pair.origin = await resolveRedirect(room.pair.origin);
    room.pair.destination = await resolveRedirect(room.pair.destination);
    room.pair.destinationOriginal = origDest;
    for (const [, p] of room.players) {
      Object.assign(p, { path: [room.pair.origin], finished: false, finishTime: null, visited: [], distances: [] });
    }
    broadcastToRoom(roomCode, {
      type: 'game_start',
      mode: 'classic',
      origin: room.pair.origin,
      destination: room.pair.destination,
    });
    // Cache destination backlinks async (don't block game start)
    cacheDestination(room.pair.destination).then(destData => {
      room.destData = destData;
      // Compute initial distance for starting article
      computeDistance(room.pair.origin, room.pair.destination, destData).then(dist => {
        for (const [pid, p] of room.players) {
          p.distances.push(dist);
        }
        broadcastToRoom(roomCode, { type: 'distance_update', distances: getDistanceMap(room) });
      });
    });
  } else {
    // Use manual articles if set, otherwise generate random.
    // Duplicate targets would make the game unwinnable (two visited slots map
    // to the same article but we require 3 distinct entries in `visited`) —
    // reject and fall back to random.
    const manualTargets = room.manualArticles?.targets;
    const manualOk = Array.isArray(manualTargets)
      && manualTargets.length === 3
      && new Set(manualTargets.map(t => normalizeArticle(t))).size === 3;
    if (manualOk) {
      room.triple = { targets: manualTargets };
    } else {
      room.triple = await getRandomTriple(viewRange);
    }
    const startArticle = room.triple.targets[0];
    for (const [, p] of room.players) {
      Object.assign(p, { path: [startArticle], finished: false, finishTime: null, visited: [startArticle], distances: [] });
    }
    broadcastToRoom(roomCode, {
      type: 'game_start',
      mode: 'tri',
      origin: startArticle,
      targets: room.triple.targets,
    });
    // Cache destination data for unvisited tri targets (targets[1] and targets[2])
    room.triDestData = {};
    for (const t of room.triple.targets.slice(1)) {
      cacheDestination(t).then(destData => {
        room.triDestData[t] = destData;
        // Compute initial distances for all players
        computeTriDistances(room, roomCode, startArticle);
      }).catch(e => console.error('Tri cache error:', e.message));
    }
  }
}

async function computeTriDistances(room, roomCode, article) {
  if (!room || !room.triDestData || !room.triple) return;
  const targets = room.triple.targets.slice(1); // the 2 destination targets
  const promises = targets.map(async t => {
    const destData = room.triDestData[t];
    if (!destData) return { target: t, distance: null };
    const d = await computeDistance(article, t, destData);
    return { target: t, distance: d };
  });
  const results = await Promise.all(promises);
  const triDists = {};
  for (const r of results) triDists[r.target] = r.distance;
  // Store per-player tri distances
  for (const [pid, p] of room.players) {
    if (p.finished) continue;
    const currentArticle = p.path[p.path.length - 1];
    // Only compute for the article the player is on
    if (currentArticle === article || article === null) {
      p.triDistances = triDists;
    }
  }
  const currentRoom = rooms.get(roomCode);
  if (currentRoom && currentRoom.started) {
    broadcastToRoom(roomCode, { type: 'distance_update', distances: getDistanceMap(currentRoom) });
  }
}

function getDistanceMap(room) {
  const map = {};
  for (const [pid, p] of room.players) {
    const len = p.distances.length;
    const curr = len > 0 ? p.distances[len - 1] : null;
    const prev = len > 1 ? p.distances[len - 2] : null;
    const entry = { name: p.name, color: p.color, distance: curr, prev, steps: p.path.length - 1 };
    if (room.mode === 'tri' && p.triDistances) {
      entry.triDistances = p.triDistances;
      entry.visited = p.visited ? p.visited.length : 0;
    }
    map[pid] = entry;
  }
  return map;
}

function checkWin(room, rp, article) {
  if (room.mode === 'classic') {
    const current = normalizeArticle(article);
    // Check against both resolved and original destination
    const destResolved = normalizeArticle(room.pair.destination);
    const destOriginal = room.pair.destinationOriginal ? normalizeArticle(room.pair.destinationOriginal) : null;
    if (current === destResolved || (destOriginal && current === destOriginal)) return true;
    // Also check if the navigated article redirects to the destination
    // (async check stored for next comparison)
    return false;
  } else {
    // Tri mode: check if this article matches any unvisited target
    const current = normalizeArticle(article);
    for (const t of room.triple.targets) {
      if (normalizeArticle(t) === current && !rp.visited.includes(t)) {
        rp.visited.push(t);
        break;
      }
    }
    // Win if all 3 targets visited
    return rp.visited.length >= room.triple.targets.length;
  }
}

async function handleAction(playerId, msg) {
  console.log(`[${playerId.slice(0,8)}] ${msg.type}`, msg.type === 'navigate' ? msg.article : '');

  switch (msg.type) {

    case 'create_room': {
      const code = generateRoomCode();
      const name = (msg.name || 'Player').slice(0, 20);
      const player = players.get(playerId);
      if (player) {
        player.name = name;
        player.roomCode = code;
      }
      rooms.set(code, initRoom(code, playerId, name));
      sendSSE(playerId, { type: 'room_created', code, playerId });
      broadcastToRoom(code, {
        type: 'player_list',
        players: [...rooms.get(code).players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })),
        host: playerId,
      });
      return { ok: true, code };
    }

    case 'join_room': {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return { ok: false, error: 'Room not found' };
      if (room.started) return { ok: false, error: 'Game already in progress' };
      if (room.players.size >= 8) return { ok: false, error: 'Room is full (max 8)' };

      const name = (msg.name || 'Player').slice(0, 20);
      const player = players.get(playerId);

      // Leave prior room first — otherwise the player has stale state in both
      // rooms, the old host pointer dangles, and player_list broadcasts keep
      // firing for a ghost member.
      if (player && player.roomCode && player.roomCode !== code) {
        const oldCode = player.roomCode;
        const oldRoom = rooms.get(oldCode);
        if (oldRoom) {
          oldRoom.players.delete(playerId);
          if (oldRoom.host === playerId) {
            const next = oldRoom.players.keys().next();
            oldRoom.host = next.done ? null : next.value;
          }
          if (oldRoom.players.size === 0) {
            rooms.delete(oldCode);
          } else {
            broadcastToRoom(oldCode, {
              type: 'player_list',
              players: [...oldRoom.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })),
              host: oldRoom.host,
            });
          }
        }
      }

      if (player) {
        player.name = name;
        player.roomCode = code;
      }
      room.players.set(playerId, newPlayerState(name, room.colorIndex));
      room.colorIndex++;
      sendSSE(playerId, { type: 'room_joined', code, playerId });
      sendSSE(playerId, { type: 'mode_changed', mode: room.mode });
      broadcastToRoom(code, {
        type: 'player_list',
        players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })),
        host: room.host,
      });
      return { ok: true };
    }

    case 'set_mode': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false, error: 'Only host can change mode' };
      if (room.started) return { ok: false };
      const mode = msg.mode === 'tri' ? 'tri' : 'classic';
      room.mode = mode;
      broadcastToRoom(player.roomCode, { type: 'mode_changed', mode });
      return { ok: true };
    }

    case 'set_difficulty': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false, error: 'Only host can change difficulty' };
      if (room.started) return { ok: false };
      // msg.viewRange = [minViews, maxViews] (monthly, last 30 days)
      if (Array.isArray(msg.viewRange) && msg.viewRange.length === 2) {
        room.viewRange = [Number(msg.viewRange[0]), Number(msg.viewRange[1])];
      } else {
        room.viewRange = null;
      }
      broadcastToRoom(player.roomCode, { type: 'difficulty_changed', viewRange: room.viewRange });
      return { ok: true };
    }

    case 'start_game': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false, error: 'Only host can start' };
      // Single player or multiplayer (2+)
      if (room.singlePlayer) {
        if (room.players.size < 1) return { ok: false, error: 'Need at least 1 player' };
      } else {
        if (room.players.size < 2) return { ok: false, error: 'Need at least 2 players' };
      }
      // Accept words from the client if provided (validated)
      if (msg.origin && msg.destination && isValidArticle(msg.origin) && isValidArticle(msg.destination)) {
        room.manualArticles = { origin: msg.origin, destination: msg.destination };
      } else if (Array.isArray(msg.targets) && msg.targets.length === 3 && msg.targets.every(t => isValidArticle(t))) {
        room.manualArticles = { targets: msg.targets };
      }
      startGameForRoom(room, player.roomCode);
      return { ok: true };
    }


    case 'navigate': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || !room.started) return { ok: false };
      const rp = room.players.get(playerId);
      if (!rp || rp.finished) return { ok: false };

      const article = msg.article;
      if (!isValidArticle(article)) return { ok: false, error: 'Invalid article' };
      rp.path.push(article);

      // For tri mode, include visited count in progress
      broadcastToRoom(player.roomCode, {
        type: 'player_progress',
        playerId,
        name: rp.name,
        color: rp.color,
        steps: rp.path.length,
        currentArticle: article,
        visited: rp.visited.length,
        mode: room.mode,
      });

      // Snapshot visited count BEFORE checkWin — checkWin mutates rp.visited
      // as a side effect. We use the delta to distinguish a newly reached
      // checkpoint from a re-visit (avoids spurious checkpoint_reached events).
      const visitedBefore = rp.visited.length;

      // Check win — first quick check, then resolve redirect if needed
      let won = checkWin(room, rp, article);
      if (!won && room.mode === 'classic') {
        // Try resolving the article in case it's a redirect to the destination
        const resolved = await resolveRedirect(article);
        if (normalizeArticle(resolved) !== normalizeArticle(article)) {
          won = checkWin(room, rp, resolved);
        }
      }
      if (won) {
        rp.finished = true;
        rp.finishTime = Date.now() - room.startTime;
        if (!room.winner) {
          room.winner = playerId;
          const results = [...room.players.entries()].map(([id, p]) => ({
            id, name: p.name, path: p.path,
            finished: p.finished, time: p.finishTime,
            isWinner: id === room.winner,
            visited: p.visited,
            distances: p.distances || [],
          }));
          broadcastToRoom(player.roomCode, {
            type: 'game_over',
            winner: rp.name,
            results,
            mode: room.mode,
            targets: room.mode === 'tri' ? room.triple.targets : null,
          });
          room.started = false;
        }
      }

      // Notify only when a NEW checkpoint was reached this navigation (not on
      // re-visits of an already-visited target).
      if (!won && room.mode === 'tri' && rp.visited.length > visitedBefore) {
        const justVisited = rp.visited[rp.visited.length - 1];
        sendSSE(playerId, {
          type: 'checkpoint_reached',
          article: justVisited,
          visited: [...rp.visited],
          remaining: room.triple.targets.length - rp.visited.length,
        });
      }

      // Compute tri distances async
      if (room.mode === 'tri' && !won && room.triDestData) {
        const rc = player.roomCode;
        const targets = room.triple.targets.slice(1);
        const unvisited = targets.filter(t => !rp.visited.includes(t));
        if (unvisited.length > 0) {
          Promise.all(unvisited.map(async t => {
            const destData = room.triDestData[t];
            if (!destData) return;
            const d = await computeDistance(article, t, destData);
            return { target: t, distance: d };
          })).then(results => {
            if (!rp.triDistances) rp.triDistances = {};
            for (const r of results) {
              if (r) rp.triDistances[r.target] = r.distance;
            }
            const currentRoom = rooms.get(rc);
            // Player may have left the room or joined a different one while
            // we were awaiting Wikipedia — skip broadcast in that case.
            if (currentRoom && currentRoom.started && currentRoom.players.has(playerId)) {
              broadcastToRoom(rc, { type: 'distance_update', distances: getDistanceMap(currentRoom) });
            }
          }).catch(e => console.error('Tri distance error:', e.message));
        }
      }

      // Compute distance async (classic mode only, don't block response)
      if (room.mode === 'classic' && !won && room.destData) {
        const rc = player.roomCode;
        computeDistance(article, room.pair.destination, room.destData).then(dist => {
          rp.distances.push(dist);
          const currentRoom = rooms.get(rc);
          if (currentRoom && currentRoom.started && currentRoom.players.has(playerId)) {
            broadcastToRoom(rc, { type: 'distance_update', distances: getDistanceMap(currentRoom) });
          }
        }).catch(e => console.error('Distance calc error:', e.message));
      }

      return { ok: true };
    }

    case 'play_again': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false };
      if (room.singlePlayer) {
        // Single player: start immediately
        room.manualArticles = null;
        startGameForRoom(room, player.roomCode);
      } else {
        // Multiplayer: go back to lobby for word preview
        room.started = false;
        room.manualArticles = null;
        room.previewWords = null;
        broadcastToRoom(player.roomCode, { type: 'returned_to_lobby' });
      }
      return { ok: true };
    }

    case 'random_word': {
      const player = players.get(playerId);
      const room = player ? rooms.get(player.roomCode) : null;
      // Use viewRange from message (SP setup) or from room (MP lobby)
      let viewRange = room?.viewRange || null;
      if (!viewRange && Array.isArray(msg.viewRange) && msg.viewRange.length === 2) {
        viewRange = [Number(msg.viewRange[0]), Number(msg.viewRange[1])];
      }
      const articles = await getGoodRandomArticles(1, viewRange);
      if (articles.length > 0) {
        return { ok: true, word: articles[0] };
      }
      return { ok: false, cooldown: true };
    }

    case 'set_articles': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false, error: 'Only host can set articles' };
      if (room.started) return { ok: false, error: 'Cannot change articles during game' };
      // Store manual articles: { origin, destination } for classic or { targets: [a,b,c] } for tri
      const origin = msg.origin;
      const destination = msg.destination;
      const targets = Array.isArray(msg.targets) ? msg.targets : null;
      if (origin !== undefined && origin !== '' && !isValidArticle(origin)) return { ok: false, error: 'Invalid origin' };
      if (destination !== undefined && destination !== '' && !isValidArticle(destination)) return { ok: false, error: 'Invalid destination' };
      if (targets && !targets.every(t => t === '' || isValidArticle(t))) return { ok: false, error: 'Invalid target' };
      room.manualArticles = {
        origin: origin || undefined,
        destination: destination || undefined,
        targets: targets || undefined,
      };
      // Broadcast update to all players
      broadcastToRoom(player.roomCode, {
        type: 'articles_updated',
        manualArticles: room.manualArticles,
      });
      return { ok: true };
    }

    case 'start_single': {
      const code = generateRoomCode();
      const name = (msg.name || 'Single Player').slice(0, 20);
      const player = players.get(playerId);
      if (player) {
        player.name = name;
        player.roomCode = code;
      }
      const room = initRoom(code, playerId, name);
      room.singlePlayer = true;
      // Apply mode and difficulty from client
      room.mode = msg.mode === 'tri' ? 'tri' : 'classic';
      if (Array.isArray(msg.viewRange) && msg.viewRange.length === 2) {
        room.viewRange = [Number(msg.viewRange[0]), Number(msg.viewRange[1])];
      }
      // Apply manual articles if provided (validated)
      if (msg.mode === 'classic' || !msg.mode) {
        const o = msg.origin, d = msg.destination;
        const validO = o && isValidArticle(o);
        const validD = d && isValidArticle(d);
        if (validO && validD) {
          room.manualArticles = { origin: o, destination: d };
        } else if (validO) {
          room.manualArticles = { origin: o };
        } else if (validD) {
          room.manualArticles = { destination: d };
        }
      } else if (msg.mode === 'tri' && Array.isArray(msg.targets) && msg.targets.length === 3) {
        if (msg.targets.every(t => isValidArticle(t))) {
          room.manualArticles = { targets: msg.targets };
        }
      }
      rooms.set(code, room);
      sendSSE(playerId, { type: 'room_created', code, playerId, singlePlayer: true });
      startGameForRoom(room, code);
      return { ok: true, code };
    }

    case 'give_up_vote': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || !room.started) return { ok: false, error: 'Game not in progress' };

      // Add vote
      room.giveUpVotes.add(playerId);
      const voteCount = room.giveUpVotes.size;
      const totalPlayers = room.players.size;

      // Broadcast vote status to all players
      broadcastToRoom(player.roomCode, {
        type: 'give_up_update',
        voted: voteCount,
        total: totalPlayers,
      });

      // Check if all players voted to give up
      if (voteCount >= totalPlayers) {
        const results = [...room.players.entries()].map(([id, p]) => ({
          id, name: p.name, path: p.path,
          finished: p.finished, time: p.finishTime,
          isWinner: false,
          visited: p.visited,
          distances: p.distances || [],
        }));
        broadcastToRoom(player.roomCode, {
          type: 'game_over',
          gaveUp: true,
          results,
          mode: room.mode,
          targets: room.mode === 'tri' ? room.triple.targets : null,
        });
        room.started = false;
      }
      return { ok: true };
    }

    case 'back_to_lobby': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room) return { ok: false };

      // Reset room state but keep players connected
      room.started = false;
      room.startTime = null;
      room.winner = null;
      room.pair = null;
      room.triple = null;
      room.giveUpVotes.clear();
      room.destData = null;
      for (const [, p] of room.players) {
        Object.assign(p, { path: [], finished: false, finishTime: null, visited: [], distances: [] });
      }

      // Broadcast lobby state
      broadcastToRoom(player.roomCode, {
        type: 'returned_to_lobby',
        mode: room.mode,
      });
      return { ok: true };
    }

    default:
      return { ok: false, error: 'Unknown action' };
  }
}

function handleDisconnect(playerId) {
  const player = players.get(playerId);
  if (!player) return;
  const roomCode = player.roomCode;
  players.delete(playerId);

  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.delete(playerId);

  if (room.players.size === 0) {
    rooms.delete(roomCode);
    console.log(`Room ${roomCode} deleted (empty)`);
  } else {
    if (room.host === playerId) {
      room.host = room.players.keys().next().value;
    }
    broadcastToRoom(roomCode, {
      type: 'player_list',
      players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })),
      host: room.host,
    });
  }
}

// ─── HTTP helpers ───
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Player-Id, X-Csrf-Token');
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  if (parsed.pathname === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(path.join(__dirname, 'favicon.svg')).pipe(res);
    return;
  }

  if (parsed.pathname === '/events' && req.method === 'GET') {
    let playerId = parsed.query.playerId;
    if (!playerId) {
      playerId = generatePlayerId();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('\n');

    // Per-session CSRF token. The client stores this in JS memory (never a
    // cookie) and echoes it back on every /action via X-Csrf-Token. An attacker
    // on another origin can't read the EventSource body from the victim's tab,
    // so they cannot forge actions even if they guess a playerId.
    const csrfToken = crypto.randomBytes(16).toString('hex');
    players.set(playerId, { res, roomCode: null, name: null, csrfToken });
    console.log(`SSE connected: ${playerId.slice(0, 8)} (total: ${players.size})`);

    sendSSE(playerId, { type: 'connected', playerId, csrfToken });

    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      console.log(`SSE disconnected: ${playerId.slice(0, 8)}`);
      handleDisconnect(playerId);
    });
    return;
  }

  if (parsed.pathname === '/action' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const msg = JSON.parse(body);
      const playerId = req.headers['x-player-id'];
      const csrfToken = req.headers['x-csrf-token'];
      const player = playerId ? players.get(playerId) : null;
      if (!player) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not connected. Open /events first.' }));
        return;
      }
      if (!csrfToken || csrfToken !== player.csrfToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid CSRF token' }));
        return;
      }
      const result = await handleAction(playerId, msg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result || { ok: true }));
    } catch (e) {
      console.error('Action error:', e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n  🎮 WikiSpeedrun is running!`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
