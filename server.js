const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── Game State ───
const rooms = new Map();
const players = new Map(); // playerId -> { res (SSE), roomCode, name }

// Wikipedia hosts per language. Add a language here + ensure the random
// article / bio-detection heuristics below know about it and it's available
// to rooms. Client's toggle must stay in sync.
// Structured session logging. Each call writes a single JSON line to stdout,
// which Railway captures and lets us grep/jq later. Free-form data field;
// always includes ISO timestamp + event name.
function logEvent(event, data = {}) {
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
  } catch (e) {
    console.error('logEvent failed:', e.message);
  }
}

const WIKI_HOSTS = {
  en: 'en.wikipedia.org',
  zh: 'zh.wikipedia.org',
};
const DEFAULT_LANG = 'en';
function normalizeLang(lang) {
  return (lang && WIKI_HOSTS[lang]) ? lang : DEFAULT_LANG;
}

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

// Validate and normalize a client-supplied viewRange. Without this, a crafted
// client could pass [NaN, Infinity] (always matches) or [100, 10] (never
// matches → silent full-pool fallback). Returns null if invalid so callers
// fall back to the intended default.
const VIEW_RANGE_MAX = 1e9;
function parseViewRange(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const a = Number(raw[0]), b = Number(raw[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 0 || b < 0 || a > b || b > VIEW_RANGE_MAX) return null;
  return [a, b];
}

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
}

function generatePlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Random article fetching from Wikipedia ───

// Quick title-based filter (no API call needed). Per-language — the English
// heuristics (word count, non-ASCII rejection) don't apply to zh.
function isBadTitle(title, lang = DEFAULT_LANG) {
  if (lang === 'zh') return isBadTitleZh(title);
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

// Chinese Wikipedia has different prefixes and "list" conventions. Also,
// rejecting non-ASCII obviously doesn't work — every normal zh article is
// non-ASCII. Rely mostly on the API validation (length, disambiguation).
function isBadTitleZh(title) {
  const t = title.replace(/_/g, ' ');
  // Namespace prefixes (Wikipedia/Template/Category/Portal/Module/File in zh)
  if (/^(维基百科|Wikipedia|模板|Template|分类|Category|门户|Portal|模块|Module|文件|File|帮助|Help|User|用户|草稿|Draft):/i.test(t)) return true;
  // Parenthetical qualifiers (disambiguation style)
  if (t.includes('(') || t.includes('（')) return true;
  // Pure digits (years)
  if (/^\d{3,4}年?$/.test(t)) return true;
  // Single-character titles are usually too ambiguous
  if (t.replace(/\s/g, '').length <= 1) return true;
  // "...列表" (list-of) at the end → skip
  if (/列表$/.test(t)) return true;
  return false;
}

// Validate articles via API: check they're real content pages (not disambig/stubs)
// Biographies get a stricter threshold — only very famous people are fun to play with
async function validateArticles(titles, lang = DEFAULT_LANG) {
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
    const data = await wikiAPI(params, lang);
    const pages = data.query?.pages || {};
    const good = [];
    for (const page of Object.values(pages)) {
      if (!page || page.missing !== undefined) continue;
      // Skip disambiguation pages
      if (page.pageprops && 'disambiguation' in page.pageprops) continue;

      // Detect biographies — check categories AND title pattern.
      // Different categories per-language.
      const cats = (page.categories || []).map(c => c.title.toLowerCase());
      let isBioByCat;
      if (lang === 'zh') {
        // zh category names: "在世人物", "XXXX年出生", "XXXX年逝世", etc.
        isBioByCat = cats.some(c =>
          c.includes('在世人物') ||
          c.includes('在世人士') ||
          /\d{1,4}年出生/.test(c) ||
          /\d{1,4}年逝世/.test(c) ||
          c.includes('传记') ||
          c.includes('演员') ||
          c.includes('歌手') ||
          c.includes('政治家') ||
          c.includes('作家') ||
          c.includes('运动员')
        );
      } else {
        isBioByCat = cats.some(c =>
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
      }
      // Title heuristic: Latin "Firstname Lastname" — doesn't apply to zh.
      const titleClean = page.title.replace(/_/g, ' ');
      const isBioByTitle = lang === 'zh'
        ? false
        : /^[A-Z][a-z]+ [A-Z][a-z]+( [A-Z][a-z]+)?$/.test(titleClean);

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
function getPageViews(titles, lang = DEFAULT_LANG) {
  const today = new Date();
  const endDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const start = new Date(today);
  start.setDate(start.getDate() - 30);
  const startDate = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`;

  const project = `${lang}.wikipedia`;
  const promises = titles.map(title => {
    const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
    const apiUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/all-access/all-agents/${encodedTitle}/daily/${startDate}/${endDate}`;
    return new Promise((resolve) => {
      https.get(apiUrl, { headers: { 'User-Agent': 'WikiSpeedrun/1.0 (https://wikispeedrun.io)' } }, (res) => {
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
// Returns array of { title, views } sorted by views desc. Cached per-language.
const topArticlesCache = new Map(); // lang -> { data, time }
const TOP_CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function getTopViewedArticles(lang = DEFAULT_LANG) {
  // Return cache if fresh
  const cached = topArticlesCache.get(lang);
  if (cached && (Date.now() - cached.time < TOP_CACHE_TTL)) {
    return cached.data;
  }

  try {
    // Try multiple days back — yesterday's data may not be available yet
    let articles = [];
    const project = `${lang}.wikipedia`;
    for (let daysBack = 1; daysBack <= 3; daysBack++) {
      const date = new Date();
      date.setDate(date.getDate() - daysBack);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');

      const apiUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${project}/all-access/${y}/${m}/${d}`;

      try {
        const result = await new Promise((resolve, reject) => {
          https.get(apiUrl, { headers: { 'User-Agent': 'WikiSpeedrun/1.0 (https://wikispeedrun.io)' } }, (res) => {
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
        if (isBadTitle(t, lang)) return false;
        return true;
      })
      .filter(a => a.views >= 1000)
      .map(a => ({ title: a.article, views: a.views * 30 }));

    topArticlesCache.set(lang, { data: filtered, time: Date.now() });
    console.log(`[top-articles:${lang}] Cached ${filtered.length} popular articles (1K+ daily views)`);
    return filtered;
  } catch (e) {
    console.error('Error fetching top articles:', e.message);
    return (topArticlesCache.get(lang)?.data) || [];
  }
}

// Pick random articles from the top-viewed pool within a view range
async function pickFromTopArticles(count, viewRange, lang = DEFAULT_LANG) {
  const top = await getTopViewedArticles(lang);
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
  const validated = await validateArticles(picked, lang);
  if (validated.length >= count) return validated.slice(0, count);

  // If first batch wasn't enough, try more from the pool
  const remaining = shuffled.slice(count * 5, count * 10).map(a => a.title);
  if (remaining.length > 0) {
    const extra = await validateArticles(remaining, lang);
    validated.push(...extra);
  }
  return validated.slice(0, count);
}

// Main article fetcher — uses different strategies based on view range
async function getGoodRandomArticles(count, viewRange, lang = DEFAULT_LANG) {
  const needed = count;

  // If no filter, use plain random
  if (!viewRange) {
    return await fetchRandomArticles(needed, lang);
  }

  const [minViews, maxViews] = viewRange;

  // High views (easy/mid): pull from top-viewed articles
  // Threshold: if min views > 5K, use the top-viewed pool
  if (minViews >= 5000) {
    const fromTop = await pickFromTopArticles(needed, viewRange, lang);
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
      const data = await wikiAPI(params, lang);
      const batch = (data.query?.random || [])
        .map(r => r.title.replace(/ /g, '_'))
        .filter(t => !isBadTitle(t, lang));

      if (batch.length === 0) continue;
      const validated = await validateArticles(batch, lang);
      if (validated.length === 0) continue;

      const viewData = await getPageViews(validated, lang);
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
    const extra = await pickFromTopArticles(needed - good.length, null, lang);
    good.push(...extra);
  }

  return good.slice(0, needed);
}

// Plain random articles (no view filtering) — extracted from old logic
async function fetchRandomArticles(count, lang = DEFAULT_LANG) {
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
      const data = await wikiAPI(params, lang);
      const batch = (data.query?.random || [])
        .map(r => r.title.replace(/ /g, '_'))
        .filter(t => !isBadTitle(t, lang));
      if (batch.length === 0) continue;
      const validated = await validateArticles(batch, lang);
      for (const a of validated) {
        if (good.length < count && !good.some(g => normalizeArticle(g) === normalizeArticle(a))) good.push(a);
      }
    } catch (e) {
      console.error('Error fetching random articles:', e.message);
    }
  }
  return good;
}

// ─── Puzzle pool ───
// Pre-generated pairs/triples per language. At game start we try the pool
// first — this avoids 5+ Wikipedia queries per new game and shields us from
// rate limiting. See scripts/generatePool.js.
const puzzlePools = {}; // { [lang]: { pairs: [], triples: [], hubs: Set<string> } }

// "Hubs" are titles that appear in ≥2 pool entries (pairs or triples).
// Rationale: the pool validates PAIRS (X→Y is solvable), not individual titles.
// The `?` button picks two titles independently, so the resulting combo was
// never validated. Filtering to hubs (well-connected articles like
// United_States, Donald_Trump) means any two independent picks are very
// likely to produce a solvable pair. Obscure single-appearance terminals
// (Jesse_Itzler, Orville_Peck) get excluded — they're valid as the destination
// of ONE specific validated pair, but dead-end for any random origin.
const HUB_MIN_APPEARANCES = 2;

function computeHubs(pool) {
  const count = new Map();
  const bump = t => count.set(t, (count.get(t) || 0) + 1);
  for (const p of (pool.pairs || []))   { bump(p.origin); bump(p.destination); }
  for (const t of (pool.triples || [])) { for (const title of t.targets) bump(title); }
  const hubs = new Set();
  for (const [title, n] of count) { if (n >= HUB_MIN_APPEARANCES) hubs.add(title); }
  return hubs;
}

function loadPuzzlePools() {
  for (const lang of Object.keys(WIKI_HOSTS)) {
    const p = path.join(__dirname, 'data', `puzzlePool.${lang}.json`);
    try {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const pool = {
          pairs: Array.isArray(raw.pairs) ? raw.pairs : [],
          triples: Array.isArray(raw.triples) ? raw.triples : [],
        };
        pool.hubs = computeHubs(pool);
        puzzlePools[lang] = pool;
        console.log(`[pool:${lang}] loaded ${pool.pairs.length} pairs + ${pool.triples.length} triples (${pool.hubs.size} hubs for ? button)`);
      } else {
        puzzlePools[lang] = { pairs: [], triples: [], hubs: new Set() };
        console.log(`[pool:${lang}] no pool file found — will use live generation`);
      }
    } catch (e) {
      console.error(`[pool:${lang}] failed to load:`, e.message);
      puzzlePools[lang] = { pairs: [], triples: [], hubs: new Set() };
    }
  }
}
loadPuzzlePools();

// Range overlap: does entry's viewRange overlap with requested?
// Null requested range = accept anything.
function rangeMatches(entry, requested) {
  if (!requested) return true;
  if (!entry.viewRange) return true;
  const [a, b] = entry.viewRange;
  const [c, d] = requested;
  return a <= d && c <= b;
}

function pickFromPool(kind, lang, viewRange) {
  const pool = puzzlePools[lang];
  if (!pool) return null;
  const entries = pool[kind === 'pair' ? 'pairs' : 'triples'];
  if (!entries || entries.length === 0) return null;
  // First narrow to entries whose view-range overlaps the request.
  const matching = entries.filter(e => rangeMatches(e, viewRange));
  const candidates = matching.length > 0 ? matching : entries; // last-resort: any entry
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Mine single article titles out of the pool for the `?` random-word button.
// Restricted to "hubs" (titles in ≥2 pool entries) so two independent `?`
// clicks produce a pair that's likely solvable — single-appearance terminals
// (Jesse_Itzler: 103 backlinks, 0 hop2) were causing unwinnable games in
// production. See HUB_MIN_APPEARANCES note above.
function pickWordFromPool(lang, viewRange, excludeSet) {
  const pool = puzzlePools[lang];
  if (!pool) return null;
  const hubs = pool.hubs || new Set();
  const candidates = [];
  for (const p of (pool.pairs || [])) {
    if (rangeMatches(p, viewRange)) { candidates.push(p.origin, p.destination); }
  }
  for (const t of (pool.triples || [])) {
    if (rangeMatches(t, viewRange)) { candidates.push(...t.targets); }
  }
  if (candidates.length === 0) return null;
  // Dedup same title appearing as both origin and destination in different pairs.
  let unique = [...new Set(candidates)];
  // Filter to hubs. Fall back to the full set if no hubs match this viewRange
  // (e.g., a thin difficulty bucket) — better a single-appearance title than
  // a 500 error.
  if (hubs.size > 0) {
    const hubsOnly = unique.filter(t => hubs.has(t));
    if (hubsOnly.length > 0) unique = hubsOnly;
  }
  // Remove recent picks so rapid clicking doesn't re-serve the same word.
  // If the exclusion empties the set, fall back to the full pool — better a
  // repeat than no result.
  if (excludeSet && excludeSet.size > 0) {
    const filtered = unique.filter(c => !excludeSet.has(c));
    if (filtered.length > 0) unique = filtered;
  }
  return unique[Math.floor(Math.random() * unique.length)];
}

// Per-player sliding window of recent `?` picks. Prevents the pool from
// serving the same word twice in a short burst of clicks.
const RECENT_PICKS_MAX = 20;
const recentPicks = new Map(); // playerId -> string[]
function rememberPick(playerId, word) {
  if (!playerId || !word) return;
  let list = recentPicks.get(playerId);
  if (!list) { list = []; recentPicks.set(playerId, list); }
  list.push(word);
  if (list.length > RECENT_PICKS_MAX) list.shift();
}
function getRecentPicks(playerId) {
  const list = recentPicks.get(playerId);
  return list ? new Set(list) : new Set();
}

async function getRandomPair(viewRange, lang = DEFAULT_LANG) {
  // Try the pool first — most games will never touch Wikipedia.
  const pooled = pickFromPool('pair', lang, viewRange);
  if (pooled) {
    // Pool entries are already canonical (validated at generation time), so
    // the caller can skip resolveRedirect → saves 2 API calls / ~300ms.
    return { origin: pooled.origin, destination: pooled.destination, fromPool: true };
  }

  // Pool empty / no match — fall through to live generation, with pool fallback
  // on any failure (429 or otherwise).
  try {
    const articles = await getGoodRandomArticles(2, viewRange, lang);
    if (articles.length >= 2 && normalizeArticle(articles[0]) !== normalizeArticle(articles[1])) {
      return { origin: articles[0], destination: articles[1] };
    }
    const retry = await getGoodRandomArticles(2, viewRange, lang);
    if (retry.length >= 2 && normalizeArticle(retry[0]) !== normalizeArticle(retry[1])) {
      return { origin: retry[0], destination: retry[1] };
    }
  } catch (e) {
    console.warn(`[pool] live pair gen failed (${e.message}) — falling back to any pool entry`);
    const any = pickFromPool('pair', lang, null);
    if (any) return { origin: any.origin, destination: any.destination };
  }
  // Last-resort hardcoded fallback.
  return lang === 'zh'
    ? { origin: '披萨', destination: '月球' }
    : { origin: 'Pizza', destination: 'Moon' };
}

async function getRandomTriple(viewRange, lang = DEFAULT_LANG) {
  const pooled = pickFromPool('triple', lang, viewRange);
  if (pooled) return { targets: pooled.targets.slice() };

  try {
    const articles = await getGoodRandomArticles(3, viewRange, lang);
    const norms = articles.map(a => normalizeArticle(a));
    if (norms.length === 3 && new Set(norms).size === 3) {
      return { targets: [articles[0], articles[1], articles[2]] };
    }
    const retry = await getGoodRandomArticles(3, viewRange, lang);
    const rNorms = retry.map(a => normalizeArticle(a));
    if (rNorms.length === 3 && new Set(rNorms).size === 3) {
      return { targets: [retry[0], retry[1], retry[2]] };
    }
  } catch (e) {
    console.warn(`[pool] live triple gen failed (${e.message}) — falling back to any pool entry`);
    const any = pickFromPool('triple', lang, null);
    if (any) return { targets: any.targets.slice() };
  }
  return lang === 'zh'
    ? { targets: ['月球', '恐龙', '爵士乐'] }
    : { targets: ['Moon', 'Dinosaur', 'Jazz'] };
}

function normalizeArticle(name) {
  return (name || '').replace(/_/g, ' ').toLowerCase();
}

// Build the composite key used to store per-language cache entries. Without
// this, `Pizza` on en.wikipedia and `Pizza` on zh.wikipedia would collide
// and a Chinese room could get English link data (or vice versa).
function cacheKey(lang, title) {
  return `${lang || DEFAULT_LANG}:${normalizeArticle(title)}`;
}

// Convert a title to the wiki's display variant (e.g. Traditional → Simplified
// for zh). Uses action=parse's displaytitle output which honors variant=zh-cn
// even when the underlying article is canonically stored in Traditional. Used
// at pool-generation time so the pool JSON only holds Simplified titles.
async function toVariantTitle(title, lang = DEFAULT_LANG) {
  if (!WIKI_VARIANTS[lang]) return title;
  try {
    const data = await wikiAPI({
      action: 'parse',
      page: title.replace(/ /g, '_'),
      prop: 'displaytitle',
      redirects: '1',
    }, lang);
    const dt = data.parse?.displaytitle || '';
    // displaytitle is HTML. Grab the main-title span when present, otherwise
    // strip tags and trim.
    const mainMatch = dt.match(/<span class="mw-page-title-main">([^<]+)<\/span>/);
    if (mainMatch && mainMatch[1]) return mainMatch[1].replace(/ /g, '_');
    const plain = dt.replace(/<[^>]+>/g, '').trim();
    return plain ? plain.replace(/ /g, '_') : title;
  } catch (e) {
    return title;
  }
}

// Resolve Wikipedia redirects to canonical title
async function resolveRedirect(title, lang = DEFAULT_LANG) {
  try {
    const data = await wikiAPI({ action: 'query', titles: title.replace(/ /g, '_'), redirects: '1' }, lang);
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
// Wikipedia links/backlinks change rarely. 24h lets a warm process amortise
// initial fetches across many games and shields us from rate limits.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
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

// MediaWiki variant codes. Chinese wiki auto-converts Simplified ↔ Traditional
// at display time; we always want Simplified output for now.
const WIKI_VARIANTS = {
  zh: 'zh-cn',
};

function wikiAPIOnce(params, lang = DEFAULT_LANG) {
  return new Promise((resolve, reject) => {
    const finalParams = { ...params, format: 'json', origin: '*' };
    if (WIKI_VARIANTS[lang]) finalParams.variant = WIKI_VARIANTS[lang];
    const qs = new URLSearchParams(finalParams);
    const host = WIKI_HOSTS[lang] || WIKI_HOSTS[DEFAULT_LANG];
    const reqUrl = `https://${host}/w/api.php?${qs}`;
    https.get(reqUrl, { headers: { 'User-Agent': 'WikiSpeedrun/1.0 (https://wikispeedrun.io)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Rate-limit / upstream error → Wikipedia returns HTML, not JSON. Let
        // the caller retry with backoff rather than bubbling a parse error
        // that poisons distance caches.
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`wiki http ${res.statusCode}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('wiki non-json response')); }
      });
    }).on('error', reject);
  });
}

// Retry transient failures with short exponential backoff. Critical: user-
// facing requests (navigate → resolveRedirect) are awaited synchronously, so
// we keep the total retry budget small — no more than ~1.5s — to protect p99.
// Background cache workers live behind a semaphore (cacheDestination) and
// their 429s don't stall any user path.
async function wikiAPI(params, lang = DEFAULT_LANG, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await wikiAPIOnce(params, lang); }
    catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        // 250ms → 500ms → 1s worst case (~1.75s total). Tight enough that a
        // 429 on a user-facing endpoint doesn't blow p99.
        const delay = 250 * Math.pow(2, i) + Math.floor(Math.random() * 150);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function getPageLinks(title, lang = DEFAULT_LANG) {
  const key = cacheKey(lang, title);
  const cached = cacheGet(linkCache, key);
  if (cached) return cached;
  const links = new Set();
  let plcontinue = null;
  let completed = false;
  try {
    do {
      const params = { action: 'query', titles: title.replace(/ /g, '_'), prop: 'links', pllimit: '500', plnamespace: '0' };
      if (plcontinue) params.plcontinue = plcontinue;
      const data = await wikiAPI(params, lang);
      const pages = data.query?.pages || {};
      for (const page of Object.values(pages)) {
        if (page.links) page.links.forEach(l => links.add(normalizeArticle(l.title)));
      }
      plcontinue = data.continue?.plcontinue;
    } while (plcontinue);
    completed = true;
  } catch (e) {
    console.error('Error fetching links for', title, e.message);
  }
  // Only cache a complete set. A partial set (from mid-pagination error) would
  // silently hide a direct link to destination from distance checks forever.
  if (completed) cacheSet(linkCache, key, links);
  return links;
}

async function getBacklinks(title, limit = 500, lang = DEFAULT_LANG) {
  const key = cacheKey(lang, title);
  const cached = cacheGet(backlinkCache, key);
  if (cached) return cached;
  const links = new Set();
  let blcontinue = null;
  let completed = false;
  try {
    do {
      const params = { action: 'query', list: 'backlinks', bltitle: title.replace(/ /g, '_'), bllimit: String(Math.min(limit - links.size, 500)), blnamespace: '0' };
      if (blcontinue) params.blcontinue = blcontinue;
      const data = await wikiAPI(params, lang);
      if (data.query?.backlinks) data.query.backlinks.forEach(l => links.add(normalizeArticle(l.title)));
      blcontinue = data.continue?.blcontinue;
    } while (blcontinue && links.size < limit);
    completed = true;
  } catch (e) {
    console.error('Error fetching backlinks for', title, e.message);
  }
  // Only cache on success — see getPageLinks for the same reasoning.
  if (completed) cacheSet(backlinkCache, key, links);
  return links;
}

// Fetch titles of all redirects that point AT the given page. Wikipedia's
// `prop=links` returns raw link targets from wikitext, so an article that
// contains `[[lunar landing]]` gives us "lunar landing" — not the canonical
// "moon landing". We expand the destination into an alias set at cache time
// so distance checks still match when a link goes through a redirect.
async function getRedirectsTo(title, lang = DEFAULT_LANG) {
  const aliases = new Set();
  let rdcontinue = null;
  try {
    do {
      const params = {
        action: 'query',
        titles: title.replace(/ /g, '_'),
        prop: 'redirects',
        rdlimit: '500',
        rdnamespace: '0',
      };
      if (rdcontinue) params.rdcontinue = rdcontinue;
      const data = await wikiAPI(params, lang);
      const pages = data.query?.pages || {};
      for (const page of Object.values(pages)) {
        if (page.redirects) {
          for (const r of page.redirects) aliases.add(normalizeArticle(r.title));
        }
      }
      rdcontinue = data.continue?.rdcontinue;
    } while (rdcontinue);
  } catch (e) {
    console.error('Error fetching redirects for', title, e.message);
  }
  return aliases;
}

async function computeDistance(currentArticle, destination, destData, lang = DEFAULT_LANG) {
  const currentNorm = normalizeArticle(currentArticle);
  const destNorm = normalizeArticle(destination);

  // Aliases = canonical title + all redirects to it. Older destData (from
  // games started before this field existed) falls back to just the canonical.
  const aliases = destData?.aliases || new Set([destNorm]);

  if (aliases.has(currentNorm)) return 0;

  // Get outgoing links from current page
  const outLinks = await getPageLinks(currentArticle, lang);

  // Distance 1: current page links to destination directly OR via any redirect
  // that resolves to destination. This catches `[[lunar landing]]` when the
  // destination is "Moon landing".
  for (const alias of aliases) {
    if (outLinks.has(alias)) return 1;
  }

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
    if (linkCache.has(cacheKey(lang, link))) cached.push(link);
    else uncached.push(link);
  }

  // Check all cached ones first (instant, no API calls)
  for (const article of cached) {
    const entry = linkCache.get(cacheKey(lang, article));
    const middleLinks = entry ? entry.value : null;
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
      batch.map(article => getPageLinks(article, lang).catch(() => new Set()))
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
// Cap how many destinations we cache at once. Each destination fires ~15
// backlink requests over its hop2 sample; unbounded concurrency (10+ games
// starting simultaneously) reliably trips Wikipedia's rate limiter. With 2
// in flight, peak is ~30 concurrent requests — well under the threshold.
const CACHE_DEST_CONCURRENCY = 2;
let cacheDestInflight = 0;
const cacheDestQueue = [];
function acquireCacheSlot() {
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (cacheDestInflight < CACHE_DEST_CONCURRENCY) {
        cacheDestInflight++;
        resolve();
      } else {
        cacheDestQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}
function releaseCacheSlot() {
  cacheDestInflight--;
  const next = cacheDestQueue.shift();
  if (next) next();
}

async function cacheDestination(destination, lang = DEFAULT_LANG) {
  await acquireCacheSlot();
  try {
    return await cacheDestinationInner(destination, lang);
  } finally {
    releaseCacheSlot();
  }
}

async function cacheDestinationInner(destination, lang = DEFAULT_LANG) {
  console.log(`[cache:${lang}] Building distance cache for: ${destination}`);
  const start = Date.now();

  // Aliases: normalized destination + every redirect title pointing at it.
  // Distance 1 check matches any of these against outLinks (that's the main
  // win — catches `[[lunar landing]]` linking to a destination of "Moon
  // landing"). We deliberately do NOT fetch backlinks for every alias: a
  // popular page can have 60+ redirects and that's 60+ extra API calls per
  // game start, which trips Wikipedia's rate limit and makes hop2 fail.
  const destNorm = normalizeArticle(destination);
  const aliases = await getRedirectsTo(destination, lang);
  aliases.add(destNorm);
  console.log(`[cache:${lang}] aliases: ${aliases.size} (including ${destNorm})`);

  // hop1: direct backlinks to destination.
  const hop1 = await getBacklinks(destination, 2000, lang);
  console.log(`[cache:${lang}] hop1: ${hop1.size} backlinks to ${destination}`);

  // hop2: backlinks to the hop1 articles. Fetching ALL hop1 backlinks would
  // be too many API calls, so we sample. Previous knobs: 50 sample × 4 batch
  // tripped rate limits when 10 games started in a burst. Trimmed to 30 × 2
  // to halve peak QPS per destination while still giving distance-3 coverage.
  const hop1Array = [...hop1];
  const HOP1_SAMPLE_SIZE = 30;
  const hop1Sample = hop1Array.length <= HOP1_SAMPLE_SIZE
    ? hop1Array
    : hop1Array.sort(() => Math.random() - 0.5).slice(0, HOP1_SAMPLE_SIZE);

  const hop2 = new Set();
  const HOP2_BATCH = 2;
  for (let i = 0; i < hop1Sample.length; i += HOP2_BATCH) {
    const batch = hop1Sample.slice(i, i + HOP2_BATCH);
    const results = await Promise.all(
      batch.map(article => getBacklinks(article, 200, lang).catch(() => new Set()))
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
  console.log(`[cache:${lang}] hop2: ${hop2.size} articles (sampled ${hop1Sample.length} hop1 nodes) in ${elapsed}s`);

  return { hop1, hop2, aliases };
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
function initRoom(code, hostId, hostName, lang = DEFAULT_LANG) {
  return {
    host: hostId,
    players: new Map([[hostId, newPlayerState(hostName, 0)]]),
    mode: 'classic', // 'classic' or 'tri'
    pair: null,       // classic mode
    triple: null,     // tri mode
    started: false,
    startTime: null,
    winner: null,
    destData: null, // { hop1: Set, hop2: Set, aliases: Set } for distance calc
    viewRange: null, // [minViews, maxViews] for difficulty filtering
    manualArticles: null, // { origin, destination } or { targets: [a,b,c] }
    giveUpVotes: new Set(), // set of playerIds who voted to give up
    singlePlayer: false, // true if room is single-player only
    colorIndex: 1, // next color index (host already took 0)
    lang: normalizeLang(lang), // Wikipedia language for this room
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
  const lang = room.lang || DEFAULT_LANG;

  if (room.mode === 'classic') {
    // Use manual articles if set, otherwise generate random
    const ma = room.manualArticles || {};
    if (ma.origin && ma.destination) {
      room.pair = { origin: ma.origin, destination: ma.destination };
    } else if (ma.origin || ma.destination) {
      const randomPair = await getRandomPair(viewRange, lang);
      room.pair = {
        origin: ma.origin || randomPair.origin,
        destination: ma.destination || randomPair.destination,
      };
    } else {
      room.pair = await getRandomPair(viewRange, lang);
    }
    // Resolve redirects to canonical titles, keep originals for fallback matching.
    // Pool pairs are already canonical — skip the network roundtrip.
    const origDest = room.pair.destination;
    if (!room.pair.fromPool) {
      room.pair.origin = await resolveRedirect(room.pair.origin, lang);
      room.pair.destination = await resolveRedirect(room.pair.destination, lang);
    }
    room.pair.destinationOriginal = origDest;
    // Variant aliases: on zh, the canonical wiki title can be Traditional
    // (太平天國) while our pool stores Simplified (太平天国). A player navigating
    // via a zh-TW/zh-HK link lands on the Traditional form, so plain string
    // equality misses the win. Build an alias set covering both forms.
    const destAliases = new Set([room.pair.destination, origDest]);
    if (WIKI_VARIANTS[lang]) {
      try {
        const variantForm = await toVariantTitle(room.pair.destination, lang);
        if (variantForm) destAliases.add(variantForm);
      } catch (e) { /* best-effort — fall back to existing aliases */ }
    }
    room.pair.destinationAliases = [...destAliases];
    // Guardrail: reject manually-set destinations with too few backlinks.
    // Pool destinations are curated so we skip; live-generated fallbacks
    // would already be popular enough. The threshold of 15 is empirical:
    // 拉布布 (7 backlinks) produced a 15-min unwinnable game; 太平天国
    // (1585 backlinks) was fine. Below 15 the game has too few entry
    // paths for realistic play.
    const manualDest = !!(room.manualArticles && room.manualArticles.destination);
    if (manualDest) {
      const MIN_BACKLINKS = 15;
      try {
        const backlinks = await getBacklinks(room.pair.destination, MIN_BACKLINKS, lang);
        if (backlinks.size < MIN_BACKLINKS) {
          const dest = room.pair.destination;
          logEvent('start_rejected_sparse', {
            roomCode, lang, destination: dest, backlinks: backlinks.size, threshold: MIN_BACKLINKS,
          });
          // Reset room so the host can try again
          room.started = false;
          room.manualArticles = null;
          room.pair = null;
          sendSSE(room.host, {
            type: 'start_rejected',
            reason: 'destination_too_isolated',
            destination: dest,
            backlinks: backlinks.size,
            message: `"${dest.replace(/_/g, ' ')}" is too isolated — only ${backlinks.size} articles link to it. Pick a more popular destination.`,
          });
          return;
        }
      } catch (e) {
        // Wikipedia API hiccup — fail open (let the game proceed) rather
        // than blocking the host on a transient network error.
        console.error('Backlink guardrail check failed, allowing game:', e.message);
      }
    }
    for (const [, p] of room.players) {
      Object.assign(p, { path: [room.pair.origin], finished: false, finishTime: null, visited: [], distances: [] });
    }
    broadcastToRoom(roomCode, {
      type: 'game_start',
      mode: 'classic',
      origin: room.pair.origin,
      destination: room.pair.destination,
      lang,
    });
    logEvent('game_started', {
      roomCode, mode: 'classic', lang,
      singlePlayer: !!room.singlePlayer,
      playerCount: room.players.size,
      viewRange: room.viewRange,
      origin: room.pair.origin,
      destination: room.pair.destination,
      manual: !!room.manualArticles,
    });
    // Cache destination backlinks async (don't block game start). Catch
    // errors so a Wikipedia hiccup doesn't produce an unhandled rejection;
    // the player just plays without an initial-distance badge, which is fine.
    cacheDestination(room.pair.destination, lang)
      .then(async destData => {
        room.destData = destData;
        // Tag the cache with the lang it was computed for, so a mid-lobby
        // set_lang can detect stale data and recompute.
        room.destDataLang = lang;
        const dist = await computeDistance(room.pair.origin, room.pair.destination, destData, lang);
        for (const [, p] of room.players) p.distances.push(dist);
        broadcastToRoom(roomCode, { type: 'distance_update', distances: getDistanceMap(room) });
      })
      .catch(e => console.error('Classic distance-cache error:', e.message));
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
      room.triple = await getRandomTriple(viewRange, lang);
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
      lang,
    });
    logEvent('game_started', {
      roomCode, mode: 'tri', lang,
      singlePlayer: !!room.singlePlayer,
      playerCount: room.players.size,
      viewRange: room.viewRange,
      targets: room.triple.targets,
      manual: !!room.manualArticles,
    });
    // Cache destination data for unvisited tri targets (targets[1] and targets[2])
    room.triDestData = {};
    for (const t of room.triple.targets.slice(1)) {
      cacheDestination(t, lang).then(destData => {
        room.triDestData[t] = destData;
        // Compute initial distances for all players
        computeTriDistances(room, roomCode, startArticle);
      }).catch(e => console.error('Tri cache error:', e.message));
    }
  }
}

async function computeTriDistances(room, roomCode, article) {
  if (!room || !room.triDestData || !room.triple) return;
  const lang = room.lang || DEFAULT_LANG;
  const targets = room.triple.targets.slice(1); // the 2 destination targets
  const promises = targets.map(async t => {
    const destData = room.triDestData[t];
    if (!destData) return { target: t, distance: null };
    const d = await computeDistance(article, t, destData, lang);
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
    // Check against every known alias of the destination. destinationAliases
    // covers canonical + pool form + (on zh) the variant-converted form so
    // Traditional↔Simplified mismatches don't hide wins.
    const aliases = room.pair.destinationAliases
      || [room.pair.destination, room.pair.destinationOriginal].filter(Boolean);
    if (aliases.some(a => normalizeArticle(a) === current)) return true;
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
      const lang = normalizeLang(msg.lang);
      const player = players.get(playerId);
      if (player) {
        player.name = name;
        player.roomCode = code;
      }
      rooms.set(code, initRoom(code, playerId, name, lang));
      sendSSE(playerId, { type: 'room_created', code, playerId, lang });
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
      sendSSE(playerId, { type: 'room_joined', code, playerId, lang: room.lang || DEFAULT_LANG });
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
      room.viewRange = parseViewRange(msg.viewRange);
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
      if (!room || !room.started) {
        // Log rejection so we can measure how often the UI thinks a nav
        // worked but the server discarded it (reconnect ghosts, late joiners).
        logEvent('navigate_rejected', {
          playerId,
          roomCode: player.roomCode,
          article: msg.article,
          reason: !room ? 'no_room' : 'not_started',
        });
        return { ok: false };
      }
      const rp = room.players.get(playerId);
      if (!rp || rp.finished) {
        logEvent('navigate_rejected', {
          playerId,
          roomCode: player.roomCode,
          article: msg.article,
          reason: !rp ? 'not_participant' : 'finished',
        });
        return { ok: false };
      }

      const article = msg.article;
      if (!isValidArticle(article)) return { ok: false, error: 'Invalid article' };
      rp.path.push(article);
      logEvent('navigate', {
        roomCode: player.roomCode, playerId, name: rp.name,
        article, step: rp.path.length - 1, mode: room.mode,
      });

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

      const roomLang = room.lang || DEFAULT_LANG;
      // Check win — first quick check, then resolve redirect if needed
      let won = checkWin(room, rp, article);
      // Detect whether the quick check already registered a checkpoint (tri
      // mode mutates rp.visited in checkWin); if nothing happened, fall
      // through to redirect + variant fallbacks below.
      const progressedBefore = won || rp.visited.length > visitedBefore;
      if (!progressedBefore) {
        // Try resolving the article in case it's a redirect to the destination
        const resolved = await resolveRedirect(article, roomLang);
        if (normalizeArticle(resolved) !== normalizeArticle(article)) {
          won = checkWin(room, rp, resolved);
        }
        // For zh: player may arrive on the Traditional form of a page whose
        // Simplified form is the destination/target (pool stores Simplified).
        // Convert the incoming title through the wiki's variant and retry.
        const progressedAfterResolve = won || rp.visited.length > visitedBefore;
        if (!progressedAfterResolve && WIKI_VARIANTS[roomLang]) {
          try {
            const variantForm = await toVariantTitle(article, roomLang);
            if (variantForm && normalizeArticle(variantForm) !== normalizeArticle(article)) {
              won = checkWin(room, rp, variantForm);
            }
          } catch (e) { /* best-effort — fall through */ }
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
          logEvent('game_over', {
            roomCode: player.roomCode,
            mode: room.mode,
            lang: room.lang || DEFAULT_LANG,
            gaveUp: false,
            winnerId: room.winner,
            winnerName: rp.name,
            durationMs: Date.now() - room.startTime,
            results: results.map(r => ({
              playerId: r.id, name: r.name,
              finished: r.finished, timeMs: r.time,
              steps: r.path.length - 1, isWinner: r.isWinner,
            })),
          });
          room.started = false;
        }
      }

      // Notify the whole room when a NEW checkpoint is reached — the hitting
      // player's client uses it for its own animation, everyone else uses it
      // to pulse that player's pill. Skips re-visits of already-visited targets.
      if (!won && room.mode === 'tri' && rp.visited.length > visitedBefore) {
        const justVisited = rp.visited[rp.visited.length - 1];
        broadcastToRoom(player.roomCode, {
          type: 'checkpoint_reached',
          playerId,
          name: rp.name,
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
            const d = await computeDistance(article, t, destData, roomLang);
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
        computeDistance(article, room.pair.destination, room.destData, roomLang).then(dist => {
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
      if (!viewRange) viewRange = parseViewRange(msg.viewRange);
      // Prefer the room's language; fall back to the lang on this one-off
      // request (SP setup sends it via msg.lang before a room exists).
      const lang = normalizeLang(room?.lang || msg.lang);

      // Pool path: single titles mined from pool pairs (dedup, range-filtered,
      // with a sliding window of this player's last N picks excluded so rapid
      // clicks don't repeat). Instant, no Wikipedia calls, no rate limit.
      const excluded = getRecentPicks(playerId);
      const poolWord = pickWordFromPool(lang, viewRange, excluded);
      if (poolWord) {
        rememberPick(playerId, poolWord);
        return { ok: true, word: poolWord };
      }

      const articles = await getGoodRandomArticles(1, viewRange, lang);
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
      const lang = normalizeLang(msg.lang);
      const player = players.get(playerId);
      if (player) {
        player.name = name;
        player.roomCode = code;
      }
      const room = initRoom(code, playerId, name, lang);
      room.singlePlayer = true;
      // Apply mode and difficulty from client
      room.mode = msg.mode === 'tri' ? 'tri' : 'classic';
      const parsedRange = parseViewRange(msg.viewRange);
      if (parsedRange) room.viewRange = parsedRange;
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
      sendSSE(playerId, { type: 'room_created', code, playerId, singlePlayer: true, lang });
      startGameForRoom(room, code);
      return { ok: true, code };
    }

    case 'set_lang': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false, error: 'Only host can change language' };
      if (room.started) return { ok: false, error: 'Cannot change language during game' };
      const newLang = normalizeLang(msg.lang);
      if (room.lang === newLang) return { ok: true };
      room.lang = newLang;
      // Any manual words the lobby had set are in the wrong language now.
      room.manualArticles = null;
      // Toss cached link data tied to the old language. Any in-flight
      // cacheDestination for the old lang will still write into
      // room.destData when it resolves, so we also stamp room.destDataLang
      // (see startGameForRoom) and verify at use time.
      room.destData = null;
      room.destDataLang = null;
      room.triDestData = null;
      broadcastToRoom(player.roomCode, { type: 'lang_changed', lang: newLang });
      return { ok: true };
    }

    case 'give_up_vote': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || !room.started) return { ok: false, error: 'Game not in progress' };

      // Add vote
      room.giveUpVotes.add(playerId);

      // Broadcast vote status to all players
      broadcastToRoom(player.roomCode, {
        type: 'give_up_update',
        voted: room.giveUpVotes.size,
        total: room.players.size,
      });

      // Check if all players voted to give up
      if (room.giveUpVotes.size >= room.players.size) {
        finalizeGiveUp(room, player.roomCode);
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

// End a started game as "gave up". Shared between the explicit give_up_vote
// path and the disconnect path (where a leaving player can tip remaining
// voters over the threshold).
function finalizeGiveUp(room, roomCode) {
  const results = [...room.players.entries()].map(([id, p]) => ({
    id, name: p.name, path: p.path,
    finished: p.finished, time: p.finishTime,
    isWinner: false,
    visited: p.visited,
    distances: p.distances || [],
  }));
  broadcastToRoom(roomCode, {
    type: 'game_over',
    gaveUp: true,
    results,
    mode: room.mode,
    targets: room.mode === 'tri' ? room.triple.targets : null,
  });
  logEvent('game_over', {
    roomCode,
    mode: room.mode,
    lang: room.lang || DEFAULT_LANG,
    gaveUp: true,
    winnerId: null,
    durationMs: room.startTime ? Date.now() - room.startTime : null,
    results: results.map(r => ({
      playerId: r.id, name: r.name,
      steps: r.path.length - 1,
    })),
  });
  room.started = false;
}

function handleDisconnect(playerId) {
  const player = players.get(playerId);
  if (!player) return;
  const roomCode = player.roomCode;
  players.delete(playerId);
  // Release their recent-picks memory so the map doesn't grow forever.
  recentPicks.delete(playerId);

  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.delete(playerId);
  // Remove their give-up vote too — otherwise a stale vote against a now-
  // shrunken player count could falsely meet the threshold (e.g. A votes,
  // A disconnects, B votes → 2/2 ends game even though C never voted).
  room.giveUpVotes?.delete(playerId);

  if (room.players.size === 0) {
    rooms.delete(roomCode);
    console.log(`Room ${roomCode} deleted (empty)`);
    logEvent('room_deleted', { roomCode });
  } else {
    if (room.host === playerId) {
      room.host = room.players.keys().next().value;
    }
    broadcastToRoom(roomCode, {
      type: 'player_list',
      players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })),
      host: room.host,
    });
    // If a game is in progress, re-broadcast the (now-smaller) vote ratio.
    // If all remaining players had already voted, the leaver was the
    // holdout — finalize the give-up now instead of waiting.
    if (room.started && room.giveUpVotes) {
      broadcastToRoom(roomCode, {
        type: 'give_up_update',
        voted: room.giveUpVotes.size,
        total: room.players.size,
      });
      if (room.giveUpVotes.size >= room.players.size && room.players.size > 0) {
        finalizeGiveUp(room, roomCode);
      }
    }
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

  // SEO: tell crawlers everything is fair game and point at the sitemap.
  if (parsed.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
    res.end(
      'User-agent: *\n' +
      'Allow: /\n' +
      'Disallow: /events\n' +
      'Disallow: /action\n' +
      'Sitemap: https://wikispeedrun.io/sitemap.xml\n'
    );
    return;
  }

  // Single-URL sitemap — the game is one page. Helps Search Console verify
  // and speeds up initial indexing.
  if (parsed.pathname === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' });
    const today = new Date().toISOString().slice(0, 10);
    res.end(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      '  <url>\n' +
      '    <loc>https://wikispeedrun.io/</loc>\n' +
      `    <lastmod>${today}</lastmod>\n` +
      '    <changefreq>weekly</changefreq>\n' +
      '    <priority>1.0</priority>\n' +
      '  </url>\n' +
      '</urlset>\n'
    );
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
    const connectedAt = Date.now();
    players.set(playerId, { res, roomCode: null, name: null, csrfToken, connectedAt });
    console.log(`SSE connected: ${playerId.slice(0, 8)} (total: ${players.size})`);
    logEvent('sse_connect', { playerId, totalConnected: players.size });

    sendSSE(playerId, { type: 'connected', playerId, csrfToken });

    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      const p = players.get(playerId);
      const sessionMs = p?.connectedAt ? Date.now() - p.connectedAt : null;
      console.log(`SSE disconnected: ${playerId.slice(0, 8)}`);
      logEvent('sse_disconnect', { playerId, roomCode: p?.roomCode || null, sessionMs });
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

// Only start the HTTP server when run directly. The pool generator imports
// this file to reuse the Wikipedia helpers without opening a port.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  🎮 WikiSpeedrun is running!`);
    console.log(`  Open http://localhost:${PORT} in your browser\n`);
  });
}

// Exports for scripts/generatePool.js (no impact when server is run directly).
module.exports = {
  getRandomPair,
  getRandomTriple,
  getGoodRandomArticles,
  cacheDestination,
  computeDistance,
  resolveRedirect,
  toVariantTitle,
  normalizeArticle,
  WIKI_HOSTS,
  DEFAULT_LANG,
};
