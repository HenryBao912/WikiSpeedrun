const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

// ─── Game State ───
const rooms = new Map();
const players = new Map(); // playerId -> { res (SSE), roomCode, name, visitorId }

// Disconnect grace: when an SSE drops we don't tear down the player + room
// immediately. EventSource auto-reconnects on transient network blips, tab
// backgrounding, or browser sleep; without a grace window the only player in
// a singleplayer room is evicted, the room is GC'd, and every subsequent
// navigate from the (auto-reconnected) client hits no_room. 30s comfortably
// covers normal reconnects without leaving zombie rooms around for long.
const DISCONNECT_GRACE_MS = 30_000;
const pendingDisconnects = new Map(); // playerId -> timeoutId

// Per-player token bucket for /action. Handlers fan out to Wikipedia (navigate
// → getPageLinks/computeDistance; marathon target picks) and grow in-memory
// state (rooms, recentPicks), so an authenticated client without a cap could
// amplify load on Wikipedia (risking our User-Agent getting rate-limited) or
// exhaust memory. Generous burst for legit play (humans click a few/sec);
// sustained spam is throttled. Buckets are dropped in handleDisconnect.
const actionBuckets = new Map(); // playerId -> { tokens, last }
const ACTION_BUCKET_MAX = 30;
const ACTION_REFILL_PER_SEC = 10;
// Global ceiling on concurrent SSE sessions. A backstop against the players Map
// (and its sockets) growing without bound under a connection flood. Generous —
// real load is nowhere near this — and reconnects are always allowed through so
// a live player is never bounced when we're near the cap.
const MAX_SSE_CONNECTIONS = 5000;
function allowAction(playerId) {
  const now = Date.now();
  let b = actionBuckets.get(playerId);
  if (!b) { b = { tokens: ACTION_BUCKET_MAX, last: now }; actionBuckets.set(playerId, b); }
  // Clamp elapsed to >= 0: Date.now() is wall-clock and can step backwards
  // (NTP correction, VM migration), which would otherwise SUBTRACT tokens and
  // spuriously 429 a legit player.
  const elapsed = Math.max(0, now - b.last);
  b.tokens = Math.min(ACTION_BUCKET_MAX, b.tokens + (elapsed / 1000) * ACTION_REFILL_PER_SEC);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Per-IP token bucket for the public /clientlog error-reporting endpoint, so a
// buggy loop or a malicious client can't flood logs/Discord. ~30 reports/min
// sustained, burst of 10. Map is bounded (evict oldest) since there's no
// disconnect event to clean it.
const clientLogBuckets = new Map(); // ip -> { tokens, last }
const CLIENTLOG_BUCKET_MAX = 10;
const CLIENTLOG_REFILL_PER_SEC = 0.5;
function allowClientLog(ip) {
  const now = Date.now();
  let b = clientLogBuckets.get(ip);
  if (!b) {
    if (clientLogBuckets.size > 5000) { const oldest = clientLogBuckets.keys().next().value; if (oldest !== undefined) clientLogBuckets.delete(oldest); }
    b = { tokens: CLIENTLOG_BUCKET_MAX, last: now };
    clientLogBuckets.set(ip, b);
  }
  const elapsed = Math.max(0, now - b.last);
  b.tokens = Math.min(CLIENTLOG_BUCKET_MAX, b.tokens + (elapsed / 1000) * CLIENTLOG_REFILL_PER_SEC);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Browser/extension noise that isn't a real app bug — dropped on BOTH client and
// server so it never logs or pings: cross-origin "Script error." (no detail),
// the benign ResizeObserver loop warning, and errors originating in extensions.
function isNoiseClientError(message) {
  if (!message) return true;
  return message === 'Script error.'
    || /ResizeObserver loop/i.test(message)
    || /-extension:\/\//i.test(message);
}

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

// ─── Last-resort crash safety ───
// Without these, a single stray throw or unhandled promise rejection takes down
// the whole process — and with it every in-memory game + open SSE connection
// (Node ≥15 exits on an unhandled rejection by default). We log full context and
// KEEP RUNNING: for a real-time game, surviving a localized bug beats dropping
// everyone. A crash-loop guard still exits cleanly if errors cascade, so a truly
// wedged process restarts (Railway) instead of spewing forever. The handlers
// themselves must never throw.
function shortStack(err) {
  const s = err && err.stack ? String(err.stack) : null;
  return s ? s.split('\n').slice(0, 8).join('\n') : null;
}

// Optional Discord crash alert. Set DISCORD_WEBHOOK_URL in the environment and a
// GENUINE crash (uncaught_exception / unhandled_rejection) pings the channel.
// Expected/handled errors (429s, illegal_move, start_rejected_sparse) never
// reach recordFatal, so this is signal-only. De-duped per error signature with a
// 5-minute cooldown, so a repeating bug — or a crash loop — can't flood the
// channel or trip Discord's own webhook rate limit. Fire-and-forget; the alert
// path must never throw or block the crash handler.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_COOLDOWN_MS = 5 * 60 * 1000;
const _discordSent = new Map(); // signature -> lastSentMs
// Global outbound token bucket. The per-signature cooldown collapses *repeats*,
// but a flood of *distinct* signatures (e.g. an abusive client POSTing varied
// messages to the public /clientlog) would each pass it. This caps total webhook
// POSTs to ~12/min regardless of signature, keeping us well under Discord's own
// ~30/min webhook limit so the alert channel can never be flooded. Genuine
// distinct crashes are rare, so legitimate alerts are unaffected.
const _webhook = { tokens: 12, last: 0, MAX: 12, refillPerSec: 0.2 };
function allowWebhook() {
  const now = Date.now();
  if (!_webhook.last) _webhook.last = now;
  _webhook.tokens = Math.min(_webhook.MAX, _webhook.tokens + (Math.max(0, now - _webhook.last) / 1000) * _webhook.refillPerSec);
  _webhook.last = now;
  if (_webhook.tokens < 1) return false;
  _webhook.tokens -= 1;
  return true;
}
// Shared Discord poster: de-dupes by `sig` (5-min cooldown), globally rate-caps,
// bounds the map, and is fire-and-forget + never-throw. Used for both server
// crashes and client errors so a recurring issue pings once, not every time.
function notifyDiscord(emoji, kind, sig, text) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const now = Date.now();
    if (_discordSent.has(sig) && now - _discordSent.get(sig) < DISCORD_COOLDOWN_MS) return;
    if (!allowWebhook()) return; // global flood cap — don't mark sent, so it can fire later
    _discordSent.set(sig, now);
    if (_discordSent.size > 300) {
      for (const [k, t] of _discordSent) if (now - t > DISCORD_COOLDOWN_MS) _discordSent.delete(k);
      // Backstop: a burst of unique sigs can outrun cooldown-based eviction, so
      // hard-cap by dropping oldest (insertion-order) entries.
      while (_discordSent.size > 300) {
        const oldest = _discordSent.keys().next().value;
        if (oldest === undefined) break;
        _discordSent.delete(oldest);
      }
    }
    // `text` can contain attacker-supplied client-error fields (/clientlog is a
    // public POST). Neutralize backtick runs so it can't escape the ``` code
    // fence, and set allowed_mentions:{parse:[]} so an "@everyone" in the body
    // can never ping the channel. `kind` is always a fixed internal constant.
    const safe = String(text).slice(0, 1800).replace(/`/g, 'ˋ');
    const body = JSON.stringify({
      content: `${emoji} **WikiSpeedrun** \`${kind}\`\n\`\`\`\n${safe}\n\`\`\``,
      allowed_mentions: { parse: [] },
    });
    // Pass the URL straight to https.request so Node resolves host/port/path
    // (Discord is always :443, but this stays correct for any webhook URL).
    const req = https.request(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});            // never surface an alert failure
    req.setTimeout(5000, () => req.destroy());
    req.write(body);
    req.end();
  } catch (_) { /* alerting must never break anything */ }
}
function notifyDiscordCrash(kind, err) {
  const msg = (err && err.message) ? err.message : String(err);
  const frame = (err && err.stack ? String(err.stack).split('\n')[1] : '') || '';
  notifyDiscord('🔴', kind, `${kind}|${msg}|${frame.trim()}`, `${msg}\n${shortStack(err) || ''}`);
}

let _uncaughtTimes = [];
function recordFatal(kind, err) {
  try {
    logEvent(kind, {
      message: (err && err.message) ? err.message : String(err),
      name: (err && err.name) || null,
      stack: shortStack(err),
    });
  } catch (_) { /* logging must never re-throw */ }
  notifyDiscordCrash(kind, err);
  const now = Date.now();
  _uncaughtTimes = _uncaughtTimes.filter(t => now - t < 10000);
  _uncaughtTimes.push(now);
  if (_uncaughtTimes.length > 50) {
    try { logEvent('crash_loop_exit', { count: _uncaughtTimes.length, windowMs: 10000 }); } catch (_) {}
    process.exit(1); // cascading failures — let the platform restart clean
  }
}
process.on('uncaughtException', (err) => recordFatal('uncaught_exception', err));
process.on('unhandledRejection', (reason) => recordFatal('unhandled_rejection', reason));

// ─── Real-user analytics: Postgres event store + GA4 Measurement Protocol ───
// Three IDs: visitorId (persistent per browser, minted client-side) identifies a
// human over time and is the Postgres source-of-truth key; gaClientId (GA's own
// cookie id when gtag wasn't blocked, else the visitorId) is the GA4 client_id so
// non-blocked users stitch to their existing GA identity instead of double-
// counting; playerId (per SSE session) is one game session. Key events are
// written to Postgres (unblockable) AND mirrored to GA4 via the Measurement
// Protocol so ad-blocked users — who never load the GA tag — still count. The
// server-side mirror tags hits delivery:'server' (it fires for EVERYONE); the
// client gtag tags delivery:'client'. EVERYTHING here is best-effort: a DB or GA
// failure is logged and swallowed, never thrown into the request/gameplay path.
// Secrets come from env only.
const DATABASE_URL = process.env.DATABASE_URL || '';
const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || '';
const GA_API_SECRET = process.env.GA_API_SECRET || '';
const GA_ENABLED = !!(GA_MEASUREMENT_ID && GA_API_SECRET);

let pgPool = null;
function pgSslConfig(connStr) {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL === 'require') return { rejectUnauthorized: false };
  // Internal/loopback hosts (Railway private network, localhost) don't use TLS;
  // managed/public endpoints do but often present a self-signed chain.
  if (/localhost|127\.0\.0\.1|\.railway\.internal/.test(connStr)) return false;
  return { rejectUnauthorized: false };
}
if (DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: pgSslConfig(DATABASE_URL),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    // A pool 'error' (idle client dropped by the server) is emitted on the pool,
    // not a query — without this listener it would crash the process.
    pgPool.on('error', (e) => logEvent('analytics_pool_error', { message: e.message }));
    initEventsTable();
  } catch (e) {
    console.error('Analytics: pg init failed — DB logging disabled:', e.message);
    logEvent('analytics_init_failed', { message: e.message });
    pgPool = null;
  }
} else {
  console.log('Analytics: DATABASE_URL not set — Postgres event logging disabled.');
}

async function initEventsTable() {
  if (!pgPool) return;
  try {
    await pgPool.query(`
      create table if not exists events (
        id bigserial primary key,
        visitor_id text not null,
        player_id text,
        event text not null,
        lang text, mode text, room_code text,
        meta jsonb,
        ts timestamptz not null default now()
      )`);
    await pgPool.query(`create index if not exists events_vid_ts on events (visitor_id, ts)`);
    await pgPool.query(`create index if not exists events_event_ts on events (event, ts)`);
    logEvent('analytics_ready', {});
  } catch (e) {
    console.error('Analytics: events table init failed:', e.message);
    logEvent('analytics_table_init_failed', { message: e.message });
  }
}

// visitorId is opaque and client-supplied, so validate before it ever touches a
// query parameter or a GA payload. UUIDs are 36 chars; cap at 64 to bound abuse.
function sanitizeVid(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

// GA4 client ids look like "1234567890.1234567890" (the _ga cookie's last two
// fields). Validate that exact shape before trusting a client-supplied value.
function sanitizeGaClientId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^\d{1,20}\.\d{1,20}$/.test(s) ? s : null;
}

// Crawlers / link-preview fetchers / headless browsers that execute enough JS to
// fire our beacons but aren't real humans. We skip them from analytics so they
// don't inflate user counts. Deliberately conservative — better to keep a
// borderline human than to under-report. (Most non-JS bots never reach here.)
// Tightened to avoid catching humans in in-app browsers (e.g. plain "discord"
// or "preview" could appear in a webview UA) — match specific bot tokens instead.
const BOT_UA_RE = /bot\b|crawler|spider|crawl|slurp|headless|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptimerobot|gtmetrix|facebookexternalhit|facebot|whatsapp|telegrambot|discordbot|slackbot|twitterbot|linkedinbot|embedly|bingpreview|redditbot|applebot|googlebot|bingbot|yandexbot|duckduckbot|baiduspider|petalbot|ahrefsbot|semrushbot|mj12bot|dotbot|prerender|python-requests|curl\/|wget|axios|node-fetch|go-http/i;
function isBotUA(ua) {
  return !!ua && BOT_UA_RE.test(ua);
}

// Resolve a visitorId from the live player record (bound at SSE connect).
function visitorIdForPlayer(playerId) {
  const p = playerId ? players.get(playerId) : null;
  return (p && p.visitorId) || null;
}

// Resolve the GA4 client id for a player: their GA cookie id if we captured it
// (so non-blocked users stitch to their existing GA identity), else the vid.
function gaClientIdForPlayer(playerId) {
  const p = playerId ? players.get(playerId) : null;
  return (p && (p.gaClientId || p.visitorId)) || null;
}

// Fire-and-forget Postgres insert. Never awaited by callers, never throws into
// them. A row needs a visitor_id (NOT NULL); if we can't resolve one we skip the
// row rather than fail — gameplay always wins over analytics.
function recordEvent(event, { visitorId, playerId = null, lang = null, mode = null, roomCode = null, meta = null } = {}) {
  if (!pgPool) return;
  try {
    const vid = visitorId || visitorIdForPlayer(playerId);
    if (!vid) return;
    // JSON.stringify can throw (circular/BigInt) — keep it inside the guard so a
    // bad meta can never throw synchronously into the gameplay path.
    const metaJson = meta ? JSON.stringify(meta) : null;
    pgPool.query(
      `insert into events (visitor_id, player_id, event, lang, mode, room_code, meta)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [vid, playerId, event, lang, mode, roomCode, metaJson],
    ).catch((e) => logEvent('analytics_insert_failed', { event, message: e.message }));
  } catch (e) {
    logEvent('analytics_insert_failed', { event, message: e && e.message });
  }
}

// Record a room-level event once PER participant: a Postgres row keyed by that
// player's visitorId, and (when mirror) a GA4 hit keyed by their GA client id —
// so multiplayer games count every distinct human and GA4 sees one event/user.
function recordRoomEvent(room, roomCode, event, { mirror = false, lang = null, mode = null, meta = null, winnerId = null } = {}) {
  if ((!pgPool && !GA_ENABLED) || !room || !room.players) return;
  try {
    for (const [pid] of room.players) {
      recordEvent(event, { playerId: pid, roomCode, lang, mode, meta });
      if (mirror) {
        const clientId = gaClientIdForPlayer(pid);
        if (!clientId) continue;
        const params = { session_id: pid };
        if (mode) params.mode = mode;
        if (lang) params.lang = lang;
        // Number, not boolean — GA4 MP may drop boolean param values.
        if (event === 'game_over') params.won = (winnerId != null && pid === winnerId) ? 1 : 0;
        sendGA4({ clientId, name: event, params });
      }
    }
  } catch (e) {
    logEvent('analytics_room_event_failed', { event, message: e && e.message });
  }
}

// Per-IP rate limit for the public /pageview beacon — normally one per page
// load, but a hostile client could spam it into DB rows / GA hits. Burst 15,
// ~0.5/s sustained. Map is bounded (evict oldest) since there's no close event.
const pageviewBuckets = new Map();
function allowPageview(ip) {
  const now = Date.now();
  let b = pageviewBuckets.get(ip);
  if (!b) {
    if (pageviewBuckets.size > 5000) { const o = pageviewBuckets.keys().next().value; if (o !== undefined) pageviewBuckets.delete(o); }
    b = { tokens: 15, last: now };
    pageviewBuckets.set(ip, b);
  }
  b.tokens = Math.min(15, b.tokens + ((now - b.last) / 1000) * 0.5);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Server-side GA4 Measurement Protocol — fires for EVERYONE, including users
// whose ad blocker kills the client gtag, so GA4 stops undercounting. clientId
// MUST be stable per browser (GA's own client id when we have it, else the
// persistent vid); a fresh id per call would re-fragment the very users we're
// recovering. engagement_time_msec is REQUIRED or GA4 won't count the event
// toward Users; delivery:'server' lets reports separate these from client hits.
// Fire-and-forget: not awaited, never throws into the request path.
function sendGA4({ clientId, name, params = {} }) {
  if (!GA_ENABLED || !clientId) return;
  try {
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(GA_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA_API_SECRET)}`;
    const body = JSON.stringify({
      client_id: clientId,
      events: [{ name, params: { engagement_time_msec: 100, delivery: 'server', ...params } }],
    });
    // global fetch (Node 18+; this app requires >=20). Intentionally not awaited.
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .catch((e) => logEvent('analytics_ga4_failed', { name, message: e && e.message }));
  } catch (e) {
    logEvent('analytics_ga4_failed', { name, message: e && e.message });
  }
}

const WIKI_HOSTS = {
  en: 'en.wikipedia.org',
  zh: 'zh.wikipedia.org',
};
const DEFAULT_LANG = 'en';
// Per Wikimedia's User-Agent policy (https://meta.wikimedia.org/wiki/
// User-Agent_policy): include a contact URL or email so they can reach us
// before applying stricter rate limits to anonymous traffic. Hoisted here
// so all wiki-touching helpers (pageviews, top-articles, query API) share
// the same identifier.
const WIKI_USER_AGENT = 'WikiSpeedrun/1.0 (https://wikispeedrun.io; mailto:hello@wikispeedrun.io)';
// Hard ceiling for any single outbound Wikipedia/Wikimedia request. Node's
// https.get has no default timeout and 'error' does NOT fire on a socket that
// connects then stalls, so without this a stalled upstream would hang the
// awaiting request (and the user-facing navigate) forever. Generous enough to
// cover paginated link fetches on huge articles; only a true stall trips it.
const WIKI_REQUEST_TIMEOUT_MS = 8000;

// ─── Pre-compressed static assets ───
// index.html is ~265KB inlined HTML+CSS+JS. We compute gzip + brotli + ETag
// once at startup so every request just pulls from a Buffer instead of
// re-reading + re-compressing. Saves ~5x bytes on the wire and keeps the
// hot path off disk. Re-run when index.html changes (server restart).
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
let indexHtmlRaw, indexHtmlGz, indexHtmlBr, indexHtmlEtag;
function loadIndexHtml() {
  indexHtmlRaw = fs.readFileSync(INDEX_HTML_PATH);
  indexHtmlGz = zlib.gzipSync(indexHtmlRaw, { level: 9 });
  // Brotli is the better choice when available — typically 15-25% smaller
  // than gzip for HTML. Maxing out the compression level is fine since we
  // only do this once at boot.
  indexHtmlBr = zlib.brotliCompressSync(indexHtmlRaw, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  indexHtmlEtag = '"' + crypto.createHash('sha1').update(indexHtmlRaw).digest('hex').slice(0, 16) + '"';
}
loadIndexHtml();

// DOMPurify is the sanitizer guarding all Wikipedia-HTML injection. It's served
// from our own origin (vendored at build time) rather than a CDN: a CDN is a
// supply-chain + availability risk — jsDelivr in particular is frequently
// blocked in mainland China, exactly the audience for the zh.wikipedia mode —
// and a missing sanitizer used to fall back to injecting raw HTML.
const PURIFY_PATH = path.join(__dirname, 'purify.min.js');
let purifyRaw, purifyGz, purifyEtag;
function loadPurify() {
  purifyRaw = fs.readFileSync(PURIFY_PATH);
  purifyGz = zlib.gzipSync(purifyRaw, { level: 9 });
  purifyEtag = '"' + crypto.createHash('sha1').update(purifyRaw).digest('hex').slice(0, 16) + '"';
}
loadPurify();
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
  // Reject Wikipedia namespace prefixes — these point at chrome (Special:Random,
  // User:foo, File:bar, Wikipedia:Sandbox, Talk:X, etc.) not real articles, and
  // would let a host trick the link/distance crawler into fanning out across
  // namespaces. Article-namespace titles never contain a colon followed by an
  // uppercase letter at position < ~20 (real articles like "Pat:_The_Story" do,
  // but never with a known namespace prefix; we only block the namespace forms).
  if (/^(Special|Wikipedia|WP|User|File|Image|Help|Talk|Template|Category|Portal|Project|Module|Draft|MediaWiki|TimedText|Book)(?:_talk)?:/i.test(s)) return false;
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
// Run an async fn over items with bounded concurrency, preserving input order.
// Used for direct-to-Wikimedia REST fan-outs (pageviews) that bypass the action-
// API slot limiter, so they don't burst the shared per-IP 429 budget all at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function getPageViews(titles, lang = DEFAULT_LANG) {
  const today = new Date();
  const endDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const start = new Date(today);
  start.setDate(start.getDate() - 30);
  const startDate = `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`;

  const project = `${lang}.wikipedia`;
  const fetchOne = (title) => {
    const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
    const apiUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/all-access/all-agents/${encodedTitle}/daily/${startDate}/${endDate}`;
    return new Promise((resolve) => {
      const req = https.get(apiUrl, { headers: { 'User-Agent': WIKI_USER_AGENT } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const total = (json.items || []).reduce((sum, d) => sum + (d.views || 0), 0);
            resolve({ title, views: total });
          } catch (e) { resolve({ title, views: 0 }); }
        });
      });
      req.on('error', () => resolve({ title, views: 0 }));
      req.setTimeout(WIKI_REQUEST_TIMEOUT_MS, () => req.destroy(new Error('pageviews timeout')));
    });
  };
  // This hits the Wikimedia REST host directly, outside the action-API slot
  // limiter. Firing all ~20 titles at once is an uncounted burst against the
  // same per-IP 429 budget, so cap concurrency to ~4 in flight.
  return mapLimit(titles, 4, fetchOne);
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
          const req = https.get(apiUrl, { headers: { 'User-Agent': WIKI_USER_AGENT } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.setTimeout(WIKI_REQUEST_TIMEOUT_MS, () => req.destroy(new Error('top-articles timeout')));
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

// ─── Daily Challenge ───
// Same puzzle for everyone today, derived deterministically from the date.
// Resets at midnight UTC. Picking from the validated en pool means we know
// the puzzle is solvable + has known difficulty characteristics.
//
// Why UTC rather than per-user local: the social mechanic (sharing,
// "I beat #17 in 4 steps") only works if everyone today sees the same
// puzzle. UTC is the simplest agreed-upon "today".
const DAILY_LAUNCH_DATE = '2026-05-12'; // Daily Challenge feature launch — today = #1
const DAILY_LAUNCH_MS = Date.parse(DAILY_LAUNCH_DATE + 'T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ─── Daily Leaderboard ───
// In-memory store, keyed by date. Each entry: { anonId, name, won, steps,
// timeMs, path, ts }. Lost on restart — acceptable for MVP since dailies
// reset at midnight UTC anyway, and Railway redeploys are rare. Move to a
// JSON file on disk or KV store when leaderboard size warrants.
const dailyLeaderboards = new Map(); // "YYYY-MM-DD" -> Array<entry>
const MAX_LEADERBOARD_RETENTION_DAYS = 14;
const MAX_NAME_LEN = 20;
const MAX_ANONID_LEN = 64;
const LEADERBOARD_TARGET_SIZE = 25; // Fakes fill out to this; real entries push fakes off the bottom.

// ─── Country / flag detection ───
// Source order:
//   1. Edge-proxy header (Cloudflare / Vercel / Railway-set) — free, fast
//   2. ipapi.co lookup with in-memory cache — falls back when no header
// Returns ISO-3166-1 alpha-2 (e.g. "US") or null. Client renders to a flag
// emoji via two regional-indicator code points.
const ipCountryCache = new Map(); // ip -> "US" / null
const COUNTRY_LOOKUP_TIMEOUT_MS = 1500;

function countryFromHeaders(req) {
  const h = req.headers;
  const code = (h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-country-code'] || '').toString().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function clientIpFromReq(req) {
  // Standard proxy chain: x-forwarded-for is comma-separated, leftmost is original client.
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

async function lookupCountryByIp(ip) {
  if (!ip) return null;
  // Skip private / loopback ranges (common in local dev) — no point geolocating.
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
    return null;
  }
  if (ipCountryCache.has(ip)) return ipCountryCache.get(ip);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), COUNTRY_LOOKUP_TIMEOUT_MS);
    const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': WIKI_USER_AGENT },
    });
    clearTimeout(t);
    if (!r.ok) throw new Error('lookup failed');
    const code = (await r.text()).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) {
      ipCountryCache.set(ip, code);
      return code;
    }
  } catch (_) { /* swallow — country is non-critical */ }
  ipCountryCache.set(ip, null);
  return null;
}

async function getCountryForReq(req) {
  const fromHeader = countryFromHeaders(req);
  if (fromHeader) return fromHeader;
  return await lookupCountryByIp(clientIpFromReq(req));
}

// Per-day caches populated as soon as the first player starts the daily.
// `dailyHop1Cache[date]` = real backlinks to today's destination (each guaranteed
// to link → destination). `dailyOriginLinksCache[date]` = forward links from
// today's origin (each guaranteed to be a valid first-step). Used to make fake
// leaderboard paths look like authentic player routes — at minimum the first
// and last hops are real Wikipedia edges.
const dailyHop1Cache = new Map();          // date -> Array<title>
const dailyOriginLinksCache = new Map();   // date -> Array<title>

function warmDailyLinkCaches(daily) {
  if (!daily) return;
  // Fire-and-forget — runs once per (date, server-process). cacheDestination
  // already runs synchronously when the first player starts, so this typically
  // hits the cache instantly. We snapshot the sets into plain arrays for
  // deterministic indexing in fake-path generation.
  cacheDestination(daily.destination, 'en').then(destData => {
    if (destData?.hop1?.size) dailyHop1Cache.set(daily.date, [...destData.hop1].slice(0, 200));
  }).catch(() => {});
  getPageLinks(daily.origin, 'en').then(links => {
    if (links?.size) dailyOriginLinksCache.set(daily.date, [...links].slice(0, 200));
  }).catch(() => {});
}

// ─── Fake leaderboard generation ───
// Cold-start UX: an empty leaderboard feels dead. Pre-fill with deterministic
// fake entries so day one feels populated. Same daily date → same fakes for
// every viewer (no inconsistency between server restarts). Real entries take
// priority and push fakes off the bottom.
const FAKE_NAMES = [
  'wikiwiz_42','PuzzleHopper','clickfast','Maya','RoamingByte','linkninja',
  'cheese_seeker','Atlas','HyperlinkHero','navigatrix','wandering_paul','foxtrot',
  'snowsong','RebelSummer','Iris','quasar','MarsRunner','BookMoth','tealcaper',
  'Linus','PixelPaige','quietfox','Theo','BananaPeel','redmaple','sage',
  'Jules','MeritOrbit','panda','spicy_otter','Calliope','knot','glitchwitch',
  'Zara','minty_fox','Edna','dewfall','sleepysam','crispycoder','Cassia',
  'TundraTaro','Vivi','rookie_cube','quill','Mochi','OakLeaf','Penny','Jin',
  'sunburn','Hank','wiseowl','breeze','sweetbun','copperjay','Roma','Yuki',
  'lazy_yak','PinkBlade','tides','Olive','Ezra','Amber','Kuma','Jasper'
];
// Plausible-looking transit articles. NOT validated paths — they just need to
// look like the kind of intermediate links a player would click through.
const FAKE_PATH_HUBS = [
  'United_States','England','New_York_City','London','World_War_II','Internet',
  'Wikipedia','Hollywood','Television','Film','Music','Wikipedia','Computer',
  'BBC','The_New_York_Times','Reuters','Apple_Inc.','Microsoft','Google',
  'India','Japan','Germany','France','Mexico','Spain','Italy','Russia',
  'Olympic_Games','FIFA','NBA','Manchester_United','Tom_Hanks','Netflix',
  'Earth','Sun','Moon','Pacific_Ocean','Mount_Everest','Amazon_River',
  'Mathematics','Physics','Biology','Chemistry','History','Geography',
  'Bill_Gates','Elon_Musk','Albert_Einstein','Plato','Aristotle',
  'Twitter','Facebook','YouTube','TikTok','Instagram','Reddit',
];

// Country code pool for fake entries. Weighted toward English-Wikipedia
// readership (US heavy, UK/Canada/Australia common, mix of EU/Asia/Latin
// America for variety). Each fake entry gets a deterministic country so
// the same fake players have the same flags every day.
const FAKE_COUNTRIES = [
  'US','US','US','US','US','US','US','US','US','US', // ~30% US
  'GB','GB','GB','GB','GB',                            // 14% UK
  'CA','CA','CA',                                       // 9% Canada
  'AU','AU',                                            // 6% Australia
  'IN','IN','IN',                                       // 9% India
  'DE','DE','FR','FR','NL','SE','PL','ES','IT',         // EU mix
  'JP','JP','KR','SG','PH','MY',                        // Asia mix
  'BR','BR','MX','AR',                                  // Latin America
  'NG','ZA','EG',                                       // Africa
  'NZ','IE',                                            // Misc anglophone
];

// Tiny seedable PRNG (mulberry32) — keeps fake generation deterministic per
// (date, daily-number) so all viewers see the exact same fake leaderboard,
// even after server restart.
function mulberry32(seed) {
  return function() {
    let t = (seed = (seed + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateFakeLeaderboard(date, daily) {
  if (!daily) return [];
  // Seed: hash(date + dailyNumber) → stable across restarts, varies per day.
  const seedHex = crypto.createHash('sha256').update(date + ':' + daily.dailyNumber).digest('hex').slice(0, 8);
  const rng = mulberry32(parseInt(seedHex, 16));
  const used = new Set();
  const entries = [];
  // Difficulty-aware step distribution: parDist is the optimal hop count.
  // Most players are within +1..+5 of par, a few near-optimal, ~12% surrender.
  const par = daily.parDist || 4;
  for (let i = 0; i < LEADERBOARD_TARGET_SIZE; i++) {
    // Pick unused name
    let nameIdx;
    do { nameIdx = Math.floor(rng() * FAKE_NAMES.length); } while (used.has(nameIdx));
    used.add(nameIdx);
    const name = FAKE_NAMES[nameIdx];
    const country = FAKE_COUNTRIES[Math.floor(rng() * FAKE_COUNTRIES.length)];

    // ~12% surrender, slightly biased to bottom of pool
    const isSurrender = rng() < 0.12;
    if (isSurrender) {
      const steps = 1 + Math.floor(rng() * 5); // 1-5 steps before giving up
      const closestHops = 1 + Math.floor(rng() * 4); // 1-4 hops away when they quit
      const path = generateFakePath(daily.origin, daily.destination, steps, rng, false, date);
      entries.push({
        anonId: `fake-${date}-${i}`,
        name, country,
        won: false, steps,
        timeMs: 30_000 + Math.floor(rng() * 240_000), // 30s-4.5m
        closestHops,
        path,
        ts: Date.now(),
        fake: true,
      });
      continue;
    }
    // Win: most cluster near par+1..par+3; a few aces (par exact); long tail to par+5
    const overPar = (rng() < 0.15) ? 0 : Math.floor(rng() * 5) + 1; // 0, or 1-5
    const steps = par + overPar;
    // Time scales loosely with steps but with variance
    const baseSec = 25 + steps * 12 + Math.floor(rng() * 60);
    const timeMs = baseSec * 1000;
    const path = generateFakePath(daily.origin, daily.destination, steps, rng, true, date);
    entries.push({
      anonId: `fake-${date}-${i}`,
      name, country,
      won: true, steps, timeMs,
      closestHops: 0,
      path,
      ts: Date.now(),
      fake: true,
    });
  }
  return entries;
}

// Build a path that LOOKS like a real Wikipedia route. Strategy:
//   - First hop: real outgoing link from origin (if cache warm)
//   - Last hop (won only): real backlink to destination (if cache warm)
//   - Middle hops: generic transit hubs that plausibly link the two
// Falls back to all-hubs when caches are cold (first leaderboard fetch
// before anyone has played). This means paths PROGRESSIVELY become more
// authentic as the day's first player warms the link caches.
function generateFakePath(origin, destination, steps, rng, won, date) {
  const hop1Pool = (date && dailyHop1Cache.get(date)) || [];
  const originLinkPool = (date && dailyOriginLinksCache.get(date)) || [];
  const path = [origin];
  const pickHub = () => FAKE_PATH_HUBS[Math.floor(rng() * FAKE_PATH_HUBS.length)];
  const pickFromArr = (arr) => arr[Math.floor(rng() * arr.length)];

  if (won) {
    // Build path: origin → [originLink] → [hubs...] → [hop1] → destination
    // Reserves hop1 for penultimate (guaranteed to link to destination).
    const middleCount = Math.max(0, steps - 2); // hops between first and penultimate
    if (originLinkPool.length > 0) {
      path.push(pickFromArr(originLinkPool));
    } else {
      path.push(pickHub());
    }
    for (let i = 1; i < middleCount; i++) {
      let cand = pickHub();
      if (cand === path[path.length - 1]) cand = FAKE_PATH_HUBS[(FAKE_PATH_HUBS.indexOf(cand) + 1) % FAKE_PATH_HUBS.length];
      path.push(cand);
    }
    if (steps >= 2) {
      // Penultimate: real backlink to destination if available.
      const penult = (hop1Pool.length > 0) ? pickFromArr(hop1Pool) : pickHub();
      if (penult !== path[path.length - 1]) path.push(penult);
      else path.push(pickHub());
    }
    path.push(destination);
  } else {
    // Surrender: terminate mid-route, didn't reach destination.
    const intermediates = steps;
    if (intermediates > 0 && originLinkPool.length > 0) {
      path.push(pickFromArr(originLinkPool));
    }
    for (let i = path.length - 1; i < intermediates; i++) {
      let cand = pickHub();
      if (cand === path[path.length - 1]) cand = FAKE_PATH_HUBS[(FAKE_PATH_HUBS.indexOf(cand) + 1) % FAKE_PATH_HUBS.length];
      path.push(cand);
    }
  }
  return path;
}

function pruneOldLeaderboards() {
  // Drop boards older than retention window so the Map doesn't grow forever.
  // Cheap to call — runs O(dates). Also prunes the per-day link caches and
  // the daily challenge cache to the same window so they don't drift.
  const cutoffMs = Date.now() - MAX_LEADERBOARD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = utcDateStr(new Date(cutoffMs));
  for (const date of dailyLeaderboards.keys()) {
    if (date < cutoffDate) dailyLeaderboards.delete(date);
  }
  for (const date of dailyHop1Cache.keys()) {
    if (date < cutoffDate) dailyHop1Cache.delete(date);
  }
  for (const date of dailyOriginLinksCache.keys()) {
    if (date < cutoffDate) dailyOriginLinksCache.delete(date);
  }
  for (const date of dailyChallengeCache.keys()) {
    if (date < cutoffDate) dailyChallengeCache.delete(date);
  }
  // ipCountryCache: simple LRU-ish trim if oversized. Capped to avoid the
  // unbounded-growth attack vector from rotating client IPs.
  const IP_CACHE_MAX = 10000;
  if (ipCountryCache.size > IP_CACHE_MAX) {
    const overshoot = ipCountryCache.size - IP_CACHE_MAX;
    const it = ipCountryCache.keys();
    for (let i = 0; i < overshoot; i++) ipCountryCache.delete(it.next().value);
  }
}

function addLeaderboardEntry(date, entry) {
  pruneOldLeaderboards();
  let board = dailyLeaderboards.get(date);
  if (!board) { board = []; dailyLeaderboards.set(date, board); }
  // First-attempt-only: ignore subsequent submissions from the same anonId.
  // Locks in the score the user committed to (Wordle/NYT model).
  if (board.some(e => e.anonId === entry.anonId)) return false;
  board.push(entry);
  return true;
}

function sortLeaderboard(arr) {
  return [...arr].sort((a, b) => {
    if (a.won !== b.won) return a.won ? -1 : 1;
    if (a.won) {
      if (a.steps !== b.steps) return a.steps - b.steps;
      return (a.timeMs || 0) - (b.timeMs || 0);
    }
    return (a.closestHops ?? 999) - (b.closestHops ?? 999);
  });
}

// Returns exactly LEADERBOARD_TARGET_SIZE entries: real entries always
// appear (substituting the worst fakes), padded with deterministic fakes
// to keep the board lively from day one. The total never exceeds the
// target — a real entry below the cap displaces the worst-ranked fake.
function getLeaderboard(date, limit = LEADERBOARD_TARGET_SIZE) {
  // Prune on the READ path too. pruneOldLeaderboards otherwise only fires on a
  // submission (addLeaderboardEntry), so a read-heavy server — or a scraper
  // cycling ?date= values — would grow dailyChallengeCache/dailyLeaderboards
  // without bound. Cheap (O(dates)) and keeps every cache within retention.
  pruneOldLeaderboards();
  const real = (dailyLeaderboards.get(date) || []).filter(e => !e.fake);
  const dailyForDate = (date === utcDateStr()) ? getDailyChallenge() : getDailyChallenge(new Date(date + 'T00:00:00Z'));
  const fakes = generateFakeLeaderboard(date, dailyForDate);
  const merged = sortLeaderboard([...real, ...fakes]);
  // Real-count > limit: just trim sorted reals to limit.
  if (real.length >= limit) return sortLeaderboard(real).slice(0, limit);
  // Take top `limit` from merged, then SUBSTITUTE: any real entry that fell
  // below `limit` swaps with the worst-ranked fake currently in the top.
  let top = merged.slice(0, limit);
  for (let i = limit; i < merged.length; i++) {
    if (merged[i].fake) continue;
    const realE = merged[i];
    for (let j = top.length - 1; j >= 0; j--) {
      if (top[j].fake) { top.splice(j, 1); top.push(realE); break; }
    }
  }
  return sortLeaderboard(top);
}

// Called from game_over sites for daily rooms. Idempotent — relies on
// addLeaderboardEntry's first-attempt-only guard (per anonId).
function submitDailyToLeaderboard(room, gaveUp) {
  if (!room.daily || !room.dailyMeta || !room.dailyAnonId) return;
  if (room.dailySubmitted) return;
  room.dailySubmitted = true;
  // Singleplayer rooms have one entry; if multiplayer dailies are added later
  // this loop already supports multiple players per room.
  for (const [pid, rp] of room.players.entries()) {
    const distances = (rp.distances || []).filter(d => d != null && Number.isFinite(d));
    addLeaderboardEntry(room.dailyMeta.date, {
      anonId: room.dailyAnonId,
      name: room.dailyName || 'Anonymous',
      country: room.dailyCountry || null,
      won: !gaveUp && rp.finished,
      steps: Math.max(0, (rp.path?.length || 1) - 1),
      timeMs: rp.finishTime || (room.startTime ? Date.now() - room.startTime : null),
      closestHops: distances.length ? Math.min(...distances) : null,
      // Full path lets the leaderboard's click-to-expand show real player
      // routes. Capped to keep payloads bounded if someone visits 100 articles.
      path: Array.isArray(rp.path) ? rp.path.slice(0, 50) : [],
      ts: Date.now(),
      fake: false,
    });
  }
}

// Hardcoded blacklist — destinations we KNOW are bad regardless of what the
// pool data claims. Pool generation uses page views as a popularity proxy,
// but views ≠ backlinks (e.g. "1win" had 350K monthly views as a trending
// gambling brand but only 3 articles linking to it, making the game
// unwinnable). Add entries here when prod logs surface a sparse destination
// that the runtime guardrail caught. Survives restarts (in-memory blacklist
// below does not).
const HARDCODED_DAILY_BLACKLIST = new Set([
  '1win',                 // 3 backlinks (caught 2026-05-19)
  'Raindrop_cake',        // 6 backlinks (caught 2026-05-23, daily was unwinnable)
  // Content unsuitable for a shareable daily/random puzzle target.
  'Suicide_methods',
  'Suicide',
  'Self-harm',
]);

// In-memory blacklist of destinations the runtime guardrail has rejected
// this process lifetime. When a daily room rejects via startGameForRoom's
// MIN_BACKLINKS check, we add to this set AND clear today's cached daily so
// the next call re-derives — flipping the day's puzzle to the next
// deterministic pick. Self-healing: one user's failure fixes today's daily
// for every later viewer. Lost on restart (HARDCODED_DAILY_BLACKLIST is the
// permanent record; add to it after prod incidents).
const rejectedDailyDestinations = new Set();

// Pick a pair for a single date from the curated pool, optionally filtering
// out pairs whose origin/destination role-collide with previously-used words.
// Note: a previous origin CAN reappear as a future destination (and vice
// versa) — only same-role reuse is blocked.
//
// Fallback ladder (each step relaxes more) when the strict filter empties:
//   1. both origin AND destination unique          (best — strict no-repeat)
//   2. destination unique (origin may repeat)      (preserves variety where it matters most)
//   3. origin unique (destination may repeat)
//   4. full curated pool                            (last resort — repeats expected)
function pickDailyPairForDate(date, usedOrigins, usedDestinations) {
  const ymd = utcDateStr(date);
  const seed = parseInt(crypto.createHash('sha256').update(ymd).digest('hex').slice(0, 8), 16);
  const fullPool = puzzlePools.en?.pairs || [];
  // Daily curation rules:
  //   - Destination popularity: >=100K monthly views (very-popular bucket
  //     only — household-name destinations like Facebook, ChatGPT, Madonna)
  //   - Distance: >=2 hops (no trivial 1-hop puzzles)
  //   - Destination word count: <=2 words (snappy + shareable; excludes
  //     titles like "UEFA Champions League" or "2026 in film")
  // Note: pool buckets are discrete; 100K threshold effectively keeps only
  // the [500K, 100M] bucket. Yields ~33 pairs (>1 month unique).
  const wordCount = (s) => (s || '').split('_').length;
  const isBadDest = (dest) => HARDCODED_DAILY_BLACKLIST.has(dest) || rejectedDailyDestinations.has(dest);
  const curated = fullPool.filter(p =>
    p.viewRange?.[0] >= 100000 &&
    p.dist >= 2 &&
    wordCount(p.destination) <= 2 &&
    !isBadDest(p.destination) // permanent + runtime blacklist
  );
  let pool = curated.length > 0 ? curated : fullPool;
  if (usedOrigins && usedDestinations) {
    const candidates = [
      pool.filter(p => !usedOrigins.has(p.origin) && !usedDestinations.has(p.destination)),
      pool.filter(p => !usedDestinations.has(p.destination)),
      pool.filter(p => !usedOrigins.has(p.origin)),
      pool,
    ];
    pool = candidates.find(c => c.length > 0) || pool;
  }
  if (pool.length === 0) return null;
  return pool[seed % pool.length];
}

// Cache resolved dailies per date. The walk-from-launch logic is O(N days),
// so caching matters once we're 30+ days deep. Lost on restart but determinism
// guarantees identical results when rebuilt.
const dailyChallengeCache = new Map();

// Resolve today's (or any date's) daily challenge. Walks forward from launch
// to the requested date, accumulating used origins/destinations and picking
// each day's pair under the no-repeat constraint. Same-role reuse blocked;
// cross-role swaps allowed (yesterday's destination → today's origin OK).
function getDailyChallenge(date = new Date()) {
  const ymd = utcDateStr(date);
  if (dailyChallengeCache.has(ymd)) return dailyChallengeCache.get(ymd);
  const targetMs = Date.parse(ymd + 'T00:00:00Z');
  if (isNaN(targetMs) || targetMs < DAILY_LAUNCH_MS) return null;
  // Reject future dates. The forward-walk below runs from launch to the target
  // one day at a time; a crafted far-future date (e.g. ?date=9999-12-31) would
  // otherwise spin millions of iterations — each a sha256 + full-pool filter —
  // and cache an entry per day: an unauthenticated CPU/memory DoS. There is no
  // daily for a day that hasn't started yet.
  if (targetMs > Date.parse(utcDateStr() + 'T00:00:00Z')) return null;
  const usedOrigins = new Set();
  const usedDestinations = new Set();
  let result = null;
  for (let cur = DAILY_LAUNCH_MS; cur <= targetMs; cur += DAY_MS) {
    const curDate = new Date(cur);
    const curYmd = utcDateStr(curDate);
    if (dailyChallengeCache.has(curYmd)) {
      const cached = dailyChallengeCache.get(curYmd);
      if (cached) {
        usedOrigins.add(cached.origin);
        usedDestinations.add(cached.destination);
      }
      if (curYmd === ymd) result = cached;
      continue;
    }
    const pair = pickDailyPairForDate(curDate, usedOrigins, usedDestinations);
    if (!pair) { dailyChallengeCache.set(curYmd, null); continue; }
    const dailyNumber = Math.max(1, Math.floor((cur - DAILY_LAUNCH_MS) / DAY_MS) + 1);
    const entry = {
      date: curYmd,
      dailyNumber,
      origin: pair.origin,
      destination: pair.destination,
      parDist: pair.dist,
    };
    dailyChallengeCache.set(curYmd, entry);
    // For PAST days, accumulate before processing the next day. For the
    // requested day itself we don't add to the sets — they're a snapshot
    // of what was used BEFORE today.
    if (cur < targetMs) {
      usedOrigins.add(pair.origin);
      usedDestinations.add(pair.destination);
    }
    if (curYmd === ymd) result = entry;
  }
  return result;
}

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
  const key = cacheKey(lang, title);
  const cached = cacheGet(redirectCache, key);
  if (cached !== undefined) return cached;
  return coalesceWiki(`redirect:${key}`, async () => {
    const c2 = cacheGet(redirectCache, key);
    if (c2 !== undefined) return c2;
    try {
      const data = await wikiAPI({ action: 'query', titles: title.replace(/ /g, '_'), redirects: '1' }, lang);
      const pages = data.query?.pages || {};
      const page = Object.values(pages)[0];
      const resolved = (page && !page.missing) ? page.title.replace(/ /g, '_') : title;
      cacheSet(redirectCache, key, resolved);
      return resolved;
    } catch (e) {
      return title;
    }
  });
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
// Marathon's per-click hit detection calls resolveRedirect on every nav, even
// for articles that aren't the target. Without a cache that's a Wikipedia
// roundtrip on every link click — visibly laggy on localhost. Cache the
// resolved canonical title so revisits and common misses are instant.
const redirectCache = new Map(); // lang|title -> { value: string, expires: number }
// Redirects-pointing-AT-a-page cache. Previously getRedirectsTo was only
// called from cacheDestination — but it ran fresh on every game start, so
// 5 games targeting Earth = 5 identical fetches. With a 24h cache, popular
// destinations are paid once.
const aliasCache = new Map(); // lang|title -> { value: Set, expires: number }

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) { cache.delete(key); return undefined; }
  // Touch: move to end so recent keys survive eviction
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(cache, key, value, ttlMs = CACHE_TTL_MS) {
  if (cache.size >= CACHE_MAX) {
    // Evict oldest (first) key — Map iterates insertion order
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

// In-flight request coalescing. When N concurrent callers ask for the same
// (lang, title) and the cache is cold, we'd otherwise issue N identical HTTP
// requests to Wikipedia — exactly the pattern that triggered the 145-error
// 429 burst we saw in prod logs (popular destinations like Earth/Mexico
// fanned out simultaneously across game starts + navigates). With coalescing
// the first caller does the fetch and the rest await the same Promise.
const inFlightWiki = new Map(); // namespaced-key -> Promise
function coalesceWiki(key, fn) {
  const existing = inFlightWiki.get(key);
  if (existing) return existing;
  const p = (async () => {
    try { return await fn(); }
    finally { inFlightWiki.delete(key); }
  })();
  inFlightWiki.set(key, p);
  return p;
}

// MediaWiki variant codes. Chinese wiki auto-converts Simplified ↔ Traditional
// at display time; we always want Simplified output for now.
const WIKI_VARIANTS = {
  zh: 'zh-cn',
};

// Cap how long a single 429 retry can wait. Wikipedia's Retry-After can be
// large (60s+) under heavy load — that would stall navigate handlers way
// past any reasonable p99 budget. Better to fail fast and let the client
// surface the issue than wedge the connection.
const RETRY_AFTER_MAX_MS = 5000;

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = parseInt(headerValue, 10);
  if (!isNaN(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  // RFC 7231 also allows HTTP-date format
  const dateMs = Date.parse(headerValue);
  if (!isNaN(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), RETRY_AFTER_MAX_MS);
  return null;
}

// Global cap on concurrent outbound Wikipedia/Wikimedia requests. A single
// player navigating through uncached articles fans out many parallel
// getPageLinks/getBacklinks (computeDistance's 2-hop neighborhood expansion,
// the move-legality check, background destination caching) — which used to
// burst past Wikipedia's anonymous rate limit and trip a wave of 429s. Excess
// requests queue here; combined with the per-request retry/backoff that honors
// Retry-After, this keeps us under the limit. 4 is conservative for anonymous
// (origin=*) traffic.
// Two limits, both enforced: a CONCURRENCY cap (≤ N requests in flight) AND a
// minimum INTERVAL between request starts (a rate cap). Concurrency alone isn't
// enough — N fast requests still produce N × (1/latency) req/s, which is what
// tripped Wikipedia's per-IP 429s during a uncached-navigation burst. The
// interval paces sustained bursts; the cap bounds parallelism.
const WIKI_MAX_CONCURRENT = 4;
const WIKI_MIN_INTERVAL_MS = 100; // ≥ this between starts → ~10 req/s ceiling
let wikiInFlight = 0;
let wikiLastStart = 0;
let wikiPumpScheduled = false;
const wikiWaiters = [];
function acquireWikiSlot() {
  return new Promise(resolve => { wikiWaiters.push(resolve); pumpWikiQueue(); });
}
function pumpWikiQueue() {
  if (!wikiWaiters.length || wikiInFlight >= WIKI_MAX_CONCURRENT) return;
  const wait = wikiLastStart + WIKI_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    if (!wikiPumpScheduled) { wikiPumpScheduled = true; setTimeout(() => { wikiPumpScheduled = false; pumpWikiQueue(); }, wait); }
    return;
  }
  wikiLastStart = Date.now();
  wikiInFlight++;
  wikiWaiters.shift()();
  if (wikiWaiters.length) pumpWikiQueue(); // let the interval gate the next one
}
function releaseWikiSlot() {
  wikiInFlight--;
  pumpWikiQueue();
}

function wikiAPIOnce(params, lang = DEFAULT_LANG) {
  return acquireWikiSlot().then(() => new Promise((resolve, reject) => {
    const finalParams = { ...params, format: 'json', origin: '*' };
    if (WIKI_VARIANTS[lang]) finalParams.variant = WIKI_VARIANTS[lang];
    const qs = new URLSearchParams(finalParams);
    const host = WIKI_HOSTS[lang] || WIKI_HOSTS[DEFAULT_LANG];
    const reqUrl = `https://${host}/w/api.php?${qs}`;
    const req = https.get(reqUrl, { headers: { 'User-Agent': WIKI_USER_AGENT } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Rate-limit / upstream error → Wikipedia returns HTML, not JSON. Let
        // the caller retry with backoff rather than bubbling a parse error
        // that poisons distance caches. Attach status + Retry-After hint so
        // the retry loop can honor them.
        if (res.statusCode && res.statusCode >= 400) {
          const err = new Error(`wiki http ${res.statusCode}`);
          err.status = res.statusCode;
          err.retryAfterMs = parseRetryAfter(res.headers['retry-after']);
          return reject(err);
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('wiki non-json response')); }
      });
    });
    req.on('error', reject);
    // A socket that connects then stalls (no FIN, no data) never fires 'error',
    // so without this the Promise — and the user-facing navigate awaiting it —
    // hangs forever and the wikiAPI retry loop never engages. Destroying the
    // request surfaces an error so the retry/backoff loop can re-issue.
    req.setTimeout(WIKI_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('wiki request timeout'));
    });
  }).finally(releaseWikiSlot));
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
        // Honor Retry-After when Wikipedia explicitly tells us how long to
        // wait (clamped to RETRY_AFTER_MAX_MS upstream). Otherwise fall back
        // to exponential backoff: 250ms → 500ms → 1s + jitter.
        const expBackoff = 250 * Math.pow(2, i) + Math.floor(Math.random() * 150);
        const delay = e.retryAfterMs != null ? Math.max(e.retryAfterMs, expBackoff) : expBackoff;
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
  return coalesceWiki(`links:${key}`, async () => {
    // Re-check cache inside the coalesced promise — a previous concurrent
    // caller may have populated it before we got the slot.
    const c2 = cacheGet(linkCache, key);
    if (c2) return c2;
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
  });
}

async function getBacklinks(title, limit = 500, lang = DEFAULT_LANG) {
  const key = cacheKey(lang, title);
  const cached = cacheGet(backlinkCache, key);
  if (cached) return cached;
  // Note: limit is part of the coalesce key so a small-limit caller doesn't
  // accidentally piggyback on (and short-circuit) a larger fetch.
  return coalesceWiki(`backlinks:${key}:${limit}`, async () => {
    const c2 = cacheGet(backlinkCache, key);
    if (c2) return c2;
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
  });
}

// Robust backlink-count estimate for the sparse-destination guardrail and the
// word-box validation. Three things the old `getBacklinks(...).size` got wrong:
//   1. It returned an empty Set on a 429/fetch error, which read as 0 backlinks
//      — so a transient rate-limit wrongly rejected popular articles (Apple_Inc.,
//      Leonardo_DiCaprio) as "too sparse". This returns null on failure so
//      callers FAIL OPEN.
//   2. It counted backlinks to the raw title, missing redirects (e.g. a redirect
//      title has near-zero backlinks). This resolves the redirect first.
//   3. It could paginate. We only need "is it >= threshold?": a full first page
//      or a continue token already proves "not sparse" — one request, no walk.
// Cached for 7 days (backlink counts barely move) to cut API load.
const backlinkCountCache = new Map(); // lang|title -> { value: number, expires }
const BACKLINK_COUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
async function countBacklinks(title, threshold, lang = DEFAULT_LANG) {
  // Resolve to the page's CANONICAL stored title before counting. redirects=1
  // follows redirects; converttitles=1 maps a variant title to the stored form.
  // The latter is essential for zh: the pool stores Simplified titles (柯震东)
  // but the page is stored Traditional (柯震東), and list=backlinks needs the
  // EXACT stored title (it does not variant-convert) — without this every
  // Simplified zh title counts as 0 backlinks and gets wrongly rejected as
  // sparse. For en (no variant) converttitles is a harmless no-op.
  let resolved = title;
  try {
    const data = await wikiAPI({ action: 'query', titles: title.replace(/ /g, '_'), redirects: '1', converttitles: '1' }, lang);
    const page = Object.values(data.query?.pages || {})[0];
    if (page && page.missing === undefined && page.title) resolved = page.title;
  } catch (e) { /* fall back to the raw title */ }
  const key = cacheKey(lang, resolved);
  const cached = cacheGet(backlinkCountCache, key);
  if (cached !== undefined) return cached;
  try {
    const data = await wikiAPI({
      action: 'query', list: 'backlinks',
      bltitle: resolved.replace(/ /g, '_'),
      bllimit: String(Math.max(1, Math.min(threshold, 500))),
      blnamespace: '0',
    }, lang);
    const page = data.query?.backlinks || [];
    const hasMore = !!data.continue?.blcontinue;
    // A full page or a continue token → at least `threshold` exist.
    const count = (page.length >= threshold || hasMore) ? threshold : page.length;
    if (process.env.DEBUG_BACKLINKS) {
      logEvent('backlink_count', { title, resolved, lang, page: page.length, hasMore, count, threshold });
    }
    cacheSet(backlinkCountCache, key, count, BACKLINK_COUNT_TTL_MS);
    return count;
  } catch (e) {
    console.error('countBacklinks failed for', title, '->', resolved, e.message);
    return null; // fail open — don't reject an article because we couldn't count
  }
}

// Fetch titles of all redirects that point AT the given page. Wikipedia's
// `prop=links` returns raw link targets from wikitext, so an article that
// contains `[[lunar landing]]` gives us "lunar landing" — not the canonical
// "moon landing". We expand the destination into an alias set at cache time
// so distance checks still match when a link goes through a redirect.
async function getRedirectsTo(title, lang = DEFAULT_LANG) {
  const key = cacheKey(lang, title);
  const cached = cacheGet(aliasCache, key);
  if (cached) return cached;
  return coalesceWiki(`aliases:${key}`, async () => {
    const c2 = cacheGet(aliasCache, key);
    if (c2) return c2;
    const aliases = new Set();
    let rdcontinue = null;
    let completed = false;
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
      completed = true;
    } catch (e) {
      console.error('Error fetching redirects for', title, e.message);
    }
    // Only cache complete results — partial alias sets would let distance
    // checks miss redirects forever.
    if (completed) cacheSet(aliasCache, key, aliases);
    return aliases;
  });
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

// Coalesce the entire cacheDestination pipeline. Without this, two games
// targeting the same destination launch two full pipelines (each: aliases
// + hop1 + 30 hop2 sample fetches + distance Map building). The inner wiki
// fetches dedupe via coalesceWiki, but the hop2 sampling + Set assembly
// still runs twice. With this map, the second caller awaits the first.
const cacheDestInFlight = new Map(); // lang|destination -> Promise<destData>

async function cacheDestination(destination, lang = DEFAULT_LANG) {
  const key = cacheKey(lang, destination);
  const existing = cacheDestInFlight.get(key);
  if (existing) return existing;
  const p = (async () => {
    await acquireCacheSlot();
    try { return await cacheDestinationInner(destination, lang); }
    finally { releaseCacheSlot(); }
  })().finally(() => cacheDestInFlight.delete(key));
  cacheDestInFlight.set(key, p);
  return p;
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

// ─── Marathon scoring ───
// Pure scoring functions used by marathon mode. Kept separate from mutable
// room state so they can be unit-tested and reasoned about in isolation.
//
// The tier constants below encode the difficulty scale players see:
//   2-hop = easiest (min enforced — 1-hop targets are filtered at generation
//           time so everyone can't just race to the same obvious link)
//   3-hop = medium
//   4+hop = hardest tier (capped — 5+ hop targets take too long to clear
//           inside the time budget)
const MARATHON_TIER_POINTS = { 2: 25, 3: 45, 4: 80 };
const MARATHON_CLICK_COST = 1;
const MARATHON_SKIP_COST = 5;
// Completion bonuses reward breadth of play — attempt lots of targets, not
// just cherry-pick the hardest. Tiers chosen so a speedrunner playing mostly
// 2-hop targets stays within ~10% of a mixed-strategy player.
const MARATHON_COMPLETION_BONUSES = [
  { threshold: 15, bonus: 100 },
  { threshold: 10, bonus: 60 },
  { threshold: 5,  bonus: 30 },
];
// Round durations (ms) the client may request.
const MARATHON_DURATIONS_MS = { '3m': 180000, '5m': 300000, '8m': 480000, '12m': 720000 };
// Hard cap on how long the round clock may be deferred while the first target
// warms (degraded 429 path, see startMarathonClock). Past this the clock starts
// regardless, so a room can never hang waiting on a candidate that never warms.
const MARATHON_WARM_HARD_CAP_MS = 30000;

function marathonBasePoints(hops) {
  // Clamp hops into the tier table: anything 4+ maps to the 4-tier reward.
  const tier = hops <= 2 ? 2 : hops === 3 ? 3 : 4;
  return MARATHON_TIER_POINTS[tier];
}

function marathonCompletionBonus(completedCount) {
  for (const { threshold, bonus } of MARATHON_COMPLETION_BONUSES) {
    if (completedCount >= threshold) return bonus;
  }
  return 0;
}

// Compute a player's final marathon score. `events` is an ordered log of
// per-target outcomes: { kind: 'hit'|'skip', hops?, clicks?, skipCost? }.
// Returning a breakdown (not just a number) so the end-of-round UI can show
// "raw points − clicks − skips + bonus" without re-deriving the pieces.
function computeMarathonScore(events) {
  let raw = 0, clicks = 0, skips = 0, completed = 0;
  for (const ev of events) {
    if (ev.kind === 'hit') {
      raw += marathonBasePoints(ev.hops);
      clicks += ev.clicks || 0;
      completed += 1;
    } else if (ev.kind === 'skip') {
      skips += MARATHON_SKIP_COST;
    }
  }
  const bonus = marathonCompletionBonus(completed);
  const total = raw - clicks * MARATHON_CLICK_COST - skips + bonus;
  return { raw, clicks, skips, completed, bonus, total };
}

// ─── Marathon target generator ───
// A marathon round presents one target at a time. Each target must be at
// least 2 hops from the player's *current* article (enforced at pick time,
// not generation time — the current article changes as the player navigates).
//
// Room-level marathon state (attached to room.marathon):
//   startArticle  shared start for all players
//   duration      ms until round ends
//   endsAt        Date.now() + duration, for client countdown
//   candidates    Map<normalizedTitle, { title, data }> pre-warmed pool
//   timerId       setTimeout handle for the end-of-round broadcast
//
// Per-player marathon state (on rp.marathonState):
//   currentTarget  { title, hops, score, shownAtStep } | null — what they're
//                  currently hunting. Null means "waiting for next target".
//   events         ordered list of hit/skip events for end-of-round scoring
//   usedTitles     Set<normalized> titles this player has already been shown
//                  (so no repeats even in a 12-minute round)

// Clear both marathon timers: the end-of-round timer and (if armed) the
// deferred-clock fallback. Used everywhere a marathon is torn down so a pending
// fallback can't fire against a finished or deleted room.
function clearMarathonTimers(marathon) {
  if (!marathon) return;
  if (marathon.timerId) { clearTimeout(marathon.timerId); marathon.timerId = null; }
  if (marathon.clockFallbackId) { clearTimeout(marathon.clockFallbackId); marathon.clockFallbackId = null; }
}

// Start the marathon round clock exactly once and arm the end-of-round timer.
// Common path: called at game_start with the deadline already in marathon.endsAt.
// Deferred path (warming outran the pre-warm cap): called when the first real
// target is delivered (or the hard-cap fallback fires) with reanchor:true to set
// a full-duration deadline from now, and broadcast:true to correct the clients
// that started on a frozen placeholder.
function startMarathonClock(room, roomCode, { reanchor = false, broadcast = false } = {}) {
  const m = room.marathon;
  if (!m || m.timerStarted) return;
  m.timerStarted = true;
  if (m.clockFallbackId) { clearTimeout(m.clockFallbackId); m.clockFallbackId = null; }
  if (reanchor) m.endsAt = Date.now() + m.duration;
  const remaining = Math.max(0, m.endsAt - Date.now());
  m.timerId = setTimeout(() => {
    endMarathonForRoom(room, roomCode).catch(e =>
      console.error('Marathon end error:', e.message));
  }, remaining);
  if (broadcast) broadcastToRoom(roomCode, { type: 'marathon_clock_start', endsAt: m.endsAt });
}

async function startMarathonForRoom(room, roomCode) {
  // A fresh round replaces room.marathon below — clear any timers still armed
  // from a prior round (incl. a deferred-clock fallback) so an orphaned timer
  // can't fire against and hijack the new round.
  clearMarathonTimers(room.marathon);
  const lang = room.lang || DEFAULT_LANG;
  const durKey = room.marathonDurationKey || '5m';
  const duration = MARATHON_DURATIONS_MS[durKey] || MARATHON_DURATIONS_MS['5m'];

  const pool = puzzlePools[lang] || { pairs: [], hubs: new Set() };
  const hubsArr = [...(pool.hubs || new Set())];
  // Start from a hub — guarantees reasonable outbound connectivity so no
  // player is stuck in a dead-end at t=0.
  const startArticle = hubsArr.length
    ? hubsArr[Math.floor(Math.random() * hubsArr.length)]
    : (lang === 'zh' ? '维基百科' : 'Wikipedia');
  const startNorm = normalizeArticle(startArticle);

  // Candidate pool: unique destinations from pair pool, excluding the start.
  // Pool destinations are already curated (reasonable backlink counts),
  // which is why we draw from the pool rather than live generation here.
  const seen = new Set([startNorm]);
  const candidateTitles = [];
  for (const pair of pool.pairs) {
    const n = normalizeArticle(pair.destination);
    if (!seen.has(n)) { seen.add(n); candidateTitles.push(pair.destination); }
  }
  // Scale the candidate pool with round length: every shown target (hit OR
  // skipped) is consumed, and a fast/skip-happy player on a long round can
  // burn through 20. If the pool is still depleted, pickMarathonTarget's
  // exhaustion guard recycles it rather than dead-ending.
  candidateTitles.sort(() => Math.random() - 0.5);
  const candidateCap = { '3m': 16, '5m': 22, '8m': 30, '12m': 40 }[durKey] || 22;
  const candidates = candidateTitles.slice(0, candidateCap);

  const marathon = {
    startArticle,
    duration,
    durationKey: durKey,
    endsAt: Date.now() + duration,
    candidates: new Map(),
    timerId: null,
    timerStarted: false,   // round clock not yet armed (see startMarathonClock)
    clockFallbackId: null, // hard-cap timer for the deferred-clock path
  };
  for (const c of candidates) {
    marathon.candidates.set(normalizeArticle(c), { title: c, data: null });
  }
  room.marathon = marathon;

  for (const [, p] of room.players) {
    Object.assign(p, {
      path: [startArticle],
      finished: false,
      visited: [],
      distances: [],
      marathonState: {
        currentTarget: null,
        events: [],
        usedTitles: new Set(),
      },
    });
  }

  // Wait just long enough for ONE candidate to land before game_start so the
  // first target is usually ready on arrival. Promise.all on 5 was blocking
  // game_start whenever Wikipedia rate-limited (429s + retries pushed the
  // wait to 15-30s — perceived as "Start does nothing"). The remaining
  // candidates keep warming in the background; client falls back to polling.
  const warmFirst = candidates.slice(0, 5);
  const warmRest = candidates.slice(5);
  const warmOne = (title) => cacheDestination(title, lang).then(data => {
    const entry = marathon.candidates.get(normalizeArticle(title));
    if (entry) entry.data = data;
  }).catch(e => {
    console.error('Marathon initial warm fail for', title, e.message);
    throw e;
  });
  // Race the first 5 — first one to succeed unblocks game_start. Cap the
  // total wait at 4 s so a wave of 429s can't stall the round indefinitely.
  await Promise.race([
    Promise.any(warmFirst.map(warmOne)).catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);

  // Anchor the round deadline now — AFTER the pre-warm wait. If a candidate
  // actually warmed during the race, the first target lands on arrival, so start
  // the clock at game_start as before. If none warmed in time (a 429 storm outran
  // the 4s cap), DEFER the clock until the first real target is delivered —
  // otherwise warming burns round time with the player stuck on "warming up…".
  // clockPending tells the client to show a full, frozen clock until then.
  const warmReady = [...marathon.candidates.values()].some(e => e.data);
  marathon.endsAt = Date.now() + duration;

  broadcastToRoom(roomCode, {
    type: 'game_start',
    mode: 'marathon',
    origin: startArticle,
    duration,
    endsAt: marathon.endsAt,
    clockPending: !warmReady,
    lang,
  });
  logEvent('game_started', {
    roomCode, mode: 'marathon', lang,
    singlePlayer: !!room.singlePlayer,
    playerCount: room.players.size,
    durationKey: durKey,
    origin: startArticle,
  });
  recordRoomEvent(room, roomCode, 'game_started', { mirror: true, lang, mode: 'marathon', meta: { durationKey: durKey } });

  if (warmReady) {
    startMarathonClock(room, roomCode); // common path — identical timing to before
  } else {
    // Degraded path: arm a hard fallback so the round still starts/ends even if
    // no candidate ever warms; the first delivered target starts it sooner.
    marathon.clockFallbackId = setTimeout(
      () => startMarathonClock(room, roomCode, { reanchor: true, broadcast: true }),
      MARATHON_WARM_HARD_CAP_MS,
    );
  }

  // Seed every player's initial state with a player_progress broadcast so
  // peers can render the pill bar from the moment the game opens, before
  // anyone has navigated. Steps=1 because path[0] is the start article.
  for (const [pid, p] of room.players) {
    broadcastToRoom(roomCode, {
      type: 'player_progress',
      playerId: pid,
      name: p.name,
      color: p.color,
      steps: 1,
      currentArticle: startArticle,
      visited: 0,
      mode: 'marathon',
      target: null,  // no target assigned yet — players request via mk_request_next
    });
  }

  // Warm remaining candidates in the background.
  warmMarathonCandidates(room, warmRest, lang);
}

async function warmMarathonCandidates(room, candidates, lang) {
  const BATCH = 3;
  for (let i = 0; i < candidates.length; i += BATCH) {
    // Abort if the room closed or switched modes mid-warm.
    if (!room.marathon || !room.started || room.mode !== 'marathon') return;
    const batch = candidates.slice(i, i + BATCH);
    await Promise.all(batch.map(async (title) => {
      try {
        const data = await cacheDestination(title, lang);
        const entry = room.marathon?.candidates.get(normalizeArticle(title));
        if (entry) entry.data = data;
      } catch (e) {
        console.error('Marathon cache fail for', title, e.message);
      }
    }));
  }
}

// Pick the next target for a player. Walks the room's candidate list in
// (shuffled) insertion order and returns the first one that's ≥2 hops from
// the player's current article AND has its distance cache warmed already.
// Returns null when no candidate is ready — caller should retry shortly.
async function pickMarathonTarget(room, rp, currentArticle) {
  const lang = room.lang || DEFAULT_LANG;
  if (!room.marathon) return null;
  const usedTitles = rp.marathonState.usedTitles;
  const currentNorm = normalizeArticle(currentArticle);

  // Bias toward easier (closer) targets while still producing variety:
  //   - Scan ALL eligible warmed candidates (capped at 20 by warm pool size)
  //   - Short-circuit on a 2-hop find (can't get easier than the floor)
  //   - Otherwise pick the lowest-hop entry; ties broken by insertion order
  //     (which is already shuffled at room start in startMarathonForRoom)
  // Previous version capped the scan at 4, which could miss closer 2-hops
  // sitting later in the candidates Map and skew picks toward higher hops.
  // computeDistance hits the in-process cache after the warm pass, so the
  // full scan stays sub-millisecond per call.
  const scan = async () => {
    const out = [];
    for (const [key, entry] of room.marathon.candidates) {
      if (usedTitles.has(key)) continue;
      if (!entry.data) continue;
      if (key === currentNorm) continue;

      const hops = await computeDistance(currentArticle, entry.title, entry.data, lang);
      if (hops < 2) continue; // 1-hop filtered per design: forces strategy

      out.push({ key, entry, hops });
      // Short-circuit on a 2-hop find — can't get any closer than the floor.
      if (hops === 2) break;
    }
    return out;
  };

  let sampled = await scan();
  if (!sampled.length) {
    // Exhaustion guard: if every WARMED candidate has already been shown to
    // this player (all consumed by prior hits/skips), recycle the used-set so
    // the round continues with repeats instead of dead-ending into a permanent
    // "warming up…" while the clock keeps running. Only when there's actually a
    // warmed pool to recycle — otherwise this is a transient "still warming"
    // null and the client should keep polling.
    const warmed = [...room.marathon.candidates.values()].filter(e => e.data);
    const everyWarmedUsed = warmed.length > 0 &&
      warmed.every(e => usedTitles.has(normalizeArticle(e.title)) || normalizeArticle(e.title) === currentNorm);
    if (everyWarmedUsed) {
      usedTitles.clear();
      sampled = await scan();
    }
  }
  if (!sampled.length) return null;

  // Stable sort: lowest hops first, ties broken by sample order (already shuffled).
  sampled.sort((a, b) => a.hops - b.hops);
  const pick = sampled[0];
  return {
    title: pick.entry.title,
    hops: Math.min(pick.hops, 4), // scoring tier clamps at 4+
    rawHops: pick.hops,
    score: marathonBasePoints(pick.hops),
  };
}

// Called from the navigate handler in marathon mode. Checks whether the
// navigated article matches the player's current target (with redirect +
// variant fallbacks, matching classic/tri logic). On a hit: records the
// event, clears currentTarget, pushes an SSE so the client can celebrate +
// request the next target. No return value — best-effort.
async function handleMarathonNavigate(room, rp, playerId, article, lang) {
  const mState = rp.marathonState;
  if (!mState || !mState.currentTarget) return;
  const target = mState.currentTarget;
  const targetNorm = normalizeArticle(target.title);
  const currentNorm = normalizeArticle(article);

  let matched = currentNorm === targetNorm;
  if (!matched) {
    try {
      const resolved = await resolveRedirect(article, lang);
      if (normalizeArticle(resolved) === targetNorm) matched = true;
    } catch {}
  }
  if (!matched && WIKI_VARIANTS[lang]) {
    try {
      const variantForm = await toVariantTitle(article, lang);
      if (variantForm && normalizeArticle(variantForm) === targetNorm) matched = true;
    } catch {}
  }
  if (!matched) return;

  // Clicks used on this target = steps since the target was shown. path
  // already includes the article that just matched, so subtract one.
  const clicks = Math.max(1, rp.path.length - 1 - target.shownAtStep);
  mState.events.push({
    kind: 'hit',
    title: target.title,
    hops: target.hops,
    clicks,
    score: target.score,
  });
  mState.currentTarget = null;

  const live = computeMarathonScore(mState.events);
  sendSSE(playerId, {
    type: 'marathon_target_hit',
    title: target.title,
    score: target.score,
    clicks,
    hops: target.hops,
    liveScore: live,
  });
}

async function endMarathonForRoom(room, roomCode) {
  if (!room.marathon) return;
  clearMarathonTimers(room.marathon);
  room.started = false;

  const results = [];
  for (const [id, p] of room.players) {
    const score = computeMarathonScore(p.marathonState?.events || []);
    results.push({
      id, name: p.name, color: p.color,
      ...score,
      events: p.marathonState?.events || [],
      path: p.path || [],
    });
  }
  // Rank: highest total wins; tiebreak by fewest clicks (efficiency).
  results.sort((a, b) => (b.total - a.total) || (a.clicks - b.clicks));
  // Flag the winner so the client's banner logic (You Won / You Suck)
  // can match existing classic/tri behavior without re-deriving rank.
  if (results.length) results[0].isWinner = true;

  broadcastToRoom(roomCode, {
    type: 'game_over',
    mode: 'marathon',
    results,
    durationKey: room.marathon.durationKey,
    daily: !!room.daily,
    dailyMeta: room.dailyMeta || null,
  });
  logEvent('game_over', {
    roomCode, mode: 'marathon',
    durationKey: room.marathon.durationKey,
    gaveUp: false,
    topScore: results[0]?.total || 0,
    playerCount: results.length,
  });
  recordRoomEvent(room, roomCode, 'game_over', { mirror: true, mode: 'marathon', meta: { gaveUp: false, durationKey: room.marathon.durationKey } });
}

// ─── Game Logic ───
function initRoom(code, hostId, hostName, lang = DEFAULT_LANG) {
  return {
    host: hostId,
    players: new Map([[hostId, newPlayerState(hostName, 0)]]),
    mode: 'classic', // 'classic' | 'tri' | 'marathon'
    pair: null,       // classic mode
    triple: null,     // tri mode
    marathon: null,   // marathon mode: { startArticle, duration, candidates, endsAt }
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

  // Marathon has a fundamentally different lifecycle (timer-driven, endless
  // target stream) so it gets its own entry point. Everything downstream
  // stays branched on room.mode so classic/tri state paths don't run.
  if (room.mode === 'marathon') {
    await startMarathonForRoom(room, roomCode);
    return;
  }

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
        // countBacklinks resolves redirects + returns null on fetch failure so
        // a transient 429 can't get a popular destination wrongly rejected.
        const backlinkCount = await countBacklinks(room.pair.destination, MIN_BACKLINKS, lang);
        if (backlinkCount !== null && backlinkCount < MIN_BACKLINKS) {
          const dest = room.pair.destination;
          logEvent('start_rejected_sparse', {
            roomCode, lang, destination: dest, backlinks: backlinkCount, threshold: MIN_BACKLINKS,
            daily: !!room.daily, dailyDate: room.dailyMeta?.date || null,
          });
          // Self-heal: if this was a daily room, blacklist the destination AND
          // invalidate the cached daily for the same date. The next /daily or
          // start_daily call will derive a fresh pair (next deterministic seed
          // slot), so all subsequent viewers see a different — and hopefully
          // valid — puzzle for today. One user's failure fixes the day.
          if (room.daily && room.dailyMeta?.date) {
            rejectedDailyDestinations.add(dest);
            dailyChallengeCache.delete(room.dailyMeta.date);
          }
          // Reset room so the host can try again
          room.started = false;
          room.manualArticles = null;
          room.pair = null;
          sendSSE(room.host, {
            type: 'start_rejected',
            reason: 'destination_too_isolated',
            destination: dest,
            backlinks: backlinkCount,
            // Daily-specific message: hide the curation detail, frame as
            // recoverable. The client routes daily rejections to home where
            // the now-self-healed daily can be retried.
            message: room.daily
              ? "Today's daily had a snag — we picked a new one. Try again."
              : `"${dest.replace(/_/g, ' ')}" has too few links to be a playable destination — try a more well-known article.`,
            daily: !!room.daily,
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
    recordRoomEvent(room, roomCode, 'game_started', { mirror: true, lang, mode: 'classic' });
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
        // Origin is path[0], so its distance belongs at index 0. Assign by
        // index, not push: this .then can resolve AFTER a fast player's first
        // navigate already wrote distances[1], and a push would then land the
        // origin distance at the wrong slot. distances[i] === hop of path[i].
        for (const [, p] of room.players) p.distances[0] = dist;
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
    recordRoomEvent(room, roomCode, 'game_started', { mirror: true, lang, mode: 'tri' });
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

// Enforce the core game rule server-side: a player may only move to an article
// that is actually an outgoing link of the page they're currently on. The
// navigate handler otherwise trusts only that a title is well-formed
// (isValidArticle), so a scripted client could POST {type:'navigate',
// article:<destination>} and win in a single hop — and because rp.path,
// rp.finishTime and rp.distances all derive from navigate events, the public
// Daily leaderboard would be fully forgeable.
//
// Fails OPEN on any infrastructure failure (Wikipedia fetch error, incomplete
// link pagination, unexpected throw). A real player clicking a legitimate link
// must NEVER be rejected because of a transient upstream hiccup; letting a
// cheater through on a rare error is the lesser harm than wedging a real game.
//
// Kill-switch: enforcement is ON by default but can be dropped to LOG-ONLY
// (shadow mode) at runtime by setting ENFORCE_MOVE_LEGALITY=false in the
// environment — every would-be rejection is still logged (navigate_rejected
// with enforced:false), so a false-reject on live traffic can be disabled
// instantly via a config change instead of a code rollback.
const ENFORCE_MOVE_LEGALITY = process.env.ENFORCE_MOVE_LEGALITY !== 'false';
async function isLegalMove(from, target, lang = DEFAULT_LANG) {
  try {
    const targetNorm = normalizeArticle(target);
    // A self-link (page linking to itself) is a harmless no-op move — never
    // worth a false rejection.
    if (normalizeArticle(from) === targetNorm) return true;

    // CRITICAL: resolve `from` through redirects before fetching its links.
    // Wikitext links routinely point at redirect forms ([[Rooster]] →
    // Chicken), and we store the player's position as the RAW clicked title.
    // prop=links on a redirect stub returns exactly one link (its target),
    // so without this resolve every click on the rendered article gets
    // rejected — prod logs showed 2,585 false rejections in one week, with
    // players hard-stuck on positions like Rooster/Spherical/Electrical_
    // voltage. resolveRedirect is cached (redirectCache), so this adds ~0ms
    // on repeat navigations.
    const fromCanonical = await resolveRedirect(from, lang);

    // Landing page IS the target: if the player's position redirects to the
    // clicked article (they're literally reading it), allow as a no-op.
    if (normalizeArticle(fromCanonical) === targetNorm) return true;

    const outLinks = await getPageLinks(fromCanonical, lang);
    // getPageLinks only CACHES complete sets. If `from` isn't cached after the
    // call, the fetch errored mid-pagination and the returned set may be
    // missing the clicked link — fail open rather than reject a real move.
    if (cacheGet(linkCache, cacheKey(lang, fromCanonical)) === undefined) return true;
    if (outLinks.size === 0) return true; // dead-end or empty fetch — fail open

    if (outLinks.has(targetNorm)) return true;

    // The clicked link may go through a redirect, or (zh) a Traditional↔
    // Simplified variant, so the raw title differs from what prop=links stored.
    // Mirror checkWin's resolve→variant fallback ladder before rejecting.
    const resolved = normalizeArticle(await resolveRedirect(target, lang));
    if (resolved !== targetNorm && outLinks.has(resolved)) return true;
    if (WIKI_VARIANTS[lang]) {
      const variant = normalizeArticle((await toVariantTitle(target, lang)) || '');
      if (variant && variant !== targetNorm && outLinks.has(variant)) return true;
    }
    return false;
  } catch (e) {
    return true; // never block a move on an unexpected error
  }
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

async function handleAction(playerId, msg, req = null) {
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
      // Find the lowest-index color not currently in use by any active player.
      // Previously this was a monotonic counter, which after 8 join+leave
      // cycles wrapped back to 0 and collided with the host's color.
      const usedColors = new Set();
      for (const [, p] of room.players) usedColors.add(p.color);
      let pickedColorIdx = 0;
      for (let i = 0; i < PLAYER_COLORS.length; i++) {
        if (!usedColors.has(PLAYER_COLORS[i])) { pickedColorIdx = i; break; }
      }
      room.players.set(playerId, newPlayerState(name, pickedColorIdx));
      // Keep colorIndex incrementing for any legacy callers, but the actual
      // assignment now uses the lowest-unused slot above.
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
      const mode = msg.mode === 'tri' ? 'tri' : msg.mode === 'marathon' ? 'marathon' : 'classic';
      room.mode = mode;
      // Marathon carries an extra `duration` option from the client.
      if (mode === 'marathon' && MARATHON_DURATIONS_MS[msg.duration]) {
        room.marathonDurationKey = msg.duration;
      }
      broadcastToRoom(player.roomCode, { type: 'mode_changed', mode, duration: room.marathonDurationKey });
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
      if (!player) return { ok: false, error: 'session_lost' };
      const room = rooms.get(player.roomCode);
      if (!room || !room.started) {
        // Log rejection so we can measure how often the UI thinks a nav
        // worked but the server discarded it (reconnect ghosts, late joiners).
        const reason = !room ? 'no_room' : 'not_started';
        logEvent('navigate_rejected', {
          playerId,
          roomCode: player.roomCode,
          article: msg.article,
          reason,
        });
        recordEvent('navigate_rejected', { playerId, roomCode: player.roomCode, meta: { article: msg.article, reason } });
        // Tell the client its game state is stale so it can show a message
        // and reset back to home — otherwise the user keeps clicking links
        // that are silently dropped (the bug we saw in prod logs).
        sendSSE(playerId, { type: 'session_lost', reason });
        return { ok: false, error: 'session_lost' };
      }
      const rp = room.players.get(playerId);
      if (!rp || rp.finished) {
        const reason = !rp ? 'not_participant' : 'finished';
        logEvent('navigate_rejected', {
          playerId,
          roomCode: player.roomCode,
          article: msg.article,
          reason,
        });
        recordEvent('navigate_rejected', { playerId, roomCode: player.roomCode, meta: { article: msg.article, reason } });
        if (!rp) sendSSE(playerId, { type: 'session_lost', reason });
        return { ok: false, error: reason };
      }

      const article = msg.article;
      if (!isValidArticle(article)) return { ok: false, error: 'Invalid article' };

      // Core anti-cheat: the move is only legal if `article` is actually linked
      // from the page the player is on. Without this the path (and the Daily
      // leaderboard built from it) is forgeable via direct navigate POSTs.
      const fromArticle = rp.path[rp.path.length - 1];
      if (fromArticle && !(await isLegalMove(fromArticle, article, room.lang || DEFAULT_LANG))) {
        // Log every would-be rejection (so enforcement can be monitored, and
        // shadow mode observed) — but only actually block when enforcement is on.
        logEvent('navigate_rejected', {
          playerId, roomCode: player.roomCode, article,
          from: fromArticle, reason: 'illegal_move', enforced: ENFORCE_MOVE_LEGALITY,
        });
        recordEvent('navigate_rejected', { playerId, roomCode: player.roomCode, mode: room.mode, meta: { article, from: fromArticle, reason: 'illegal_move', enforced: ENFORCE_MOVE_LEGALITY } });
        if (ENFORCE_MOVE_LEGALITY) {
          sendSSE(playerId, { type: 'move_rejected', article, from: fromArticle });
          return { ok: false, error: 'illegal_move' };
        }
      }

      rp.path.push(article);
      // Bind this navigation's distance slot NOW, synchronously, before any
      // await. Capturing rp.path.length-1 later (inside the async distance
      // .then, which runs after the win-check awaits) would race a concurrent
      // same-player navigate that grew rp.path in the meantime, writing this
      // article's distance into the wrong slot. distances[i] === hop of path[i].
      const navStepIndex = rp.path.length - 1;
      logEvent('navigate', {
        roomCode: player.roomCode, playerId, name: rp.name,
        article, step: rp.path.length - 1, mode: room.mode,
      });
      recordEvent('navigate', {
        playerId, roomCode: player.roomCode, mode: room.mode, lang: room.lang || DEFAULT_LANG,
        meta: { article, step: rp.path.length - 1 },
      });

      // For tri mode, include visited count in progress. For marathon, also
      // include the current target so peers can decide whether to render this
      // player's pill (only shown when their target matches yours).
      const progressMsg = {
        type: 'player_progress',
        playerId,
        name: rp.name,
        color: rp.color,
        steps: rp.path.length,
        currentArticle: article,
        visited: rp.visited.length,
        mode: room.mode,
      };
      if (room.mode === 'marathon') {
        progressMsg.target = rp.marathonState?.currentTarget?.title || null;
      }
      broadcastToRoom(player.roomCode, progressMsg);

      // Marathon has its own completion flow (record hit, clear target,
      // client requests next). Classic/tri win logic doesn't apply.
      if (room.mode === 'marathon') {
        const mLang = room.lang || DEFAULT_LANG;
        // Warm the new article's outgoing links in the background. After a
        // hit, pickMarathonTarget needs them to compute distance — without
        // this prefetch the player waits on a Wikipedia roundtrip BETWEEN
        // every target reveal, which is the biggest source of marathon lag.
        getPageLinks(article, mLang).catch(() => {});
        await handleMarathonNavigate(room, rp, playerId, article, mLang);
        return { ok: true };
      }

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
          if (room.daily) submitDailyToLeaderboard(room, false);
          broadcastToRoom(player.roomCode, {
            type: 'game_over',
            winner: rp.name,
            results,
            mode: room.mode,
            targets: room.mode === 'tri' ? (room.triple?.targets || null) : null,
            daily: !!room.daily,
            dailyMeta: room.dailyMeta || null,
          });
          recordRoomEvent(room, player.roomCode, 'game_over', { mirror: true, mode: room.mode, lang: room.lang || DEFAULT_LANG, winnerId: room.winner, meta: { gaveUp: false, winnerId: room.winner } });
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

      // Compute distance async (classic mode only, don't block response).
      // Write the result at the step's OWN index rather than push()ing: two
      // rapid navigates resolve out of order otherwise, so distances[k] could
      // hold path[k+1]'s hop count — corrupting the closer/further arrows and
      // the results-screen replay. distances[i] === hop count of path[i].
      if (room.mode === 'classic' && !won && room.destData) {
        const rc = player.roomCode;
        computeDistance(article, room.pair.destination, room.destData, roomLang).then(dist => {
          // Only write if this step is STILL the live article at navStepIndex.
          // A navigate_undo can pop the step, or a play_again can reset the path,
          // while this multi-second Wikipedia round-trip is in flight — writing
          // unconditionally would re-grow rp.distances past path length (stale
          // trailing value → wrong live HUD distance) or pollute the next round.
          if (navStepIndex >= rp.path.length || normalizeArticle(rp.path[navStepIndex]) !== normalizeArticle(article)) return;
          rp.distances[navStepIndex] = dist;
          const currentRoom = rooms.get(rc);
          if (currentRoom && currentRoom.started && currentRoom.players.has(playerId)) {
            broadcastToRoom(rc, { type: 'distance_update', distances: getDistanceMap(currentRoom) });
          }
        }).catch(e => console.error('Distance calc error:', e.message));
      }

      return { ok: true };
    }

    case 'navigate_undo': {
      // The client optimistically navigated to an article that then failed to
      // LOAD on their end (transient fetch error / sanitizer unavailable). The
      // server may have already accepted that move, so undo it here to keep
      // rp.path aligned with what the player actually sees — otherwise the next
      // move is validated against an article they never reached.
      const player = players.get(playerId);
      if (!player) return { ok: false, error: 'session_lost' };
      const room = rooms.get(player.roomCode);
      if (!room || !room.started) return { ok: false, error: 'no_room' };
      const rp = room.players.get(playerId);
      if (!rp || rp.finished) return { ok: false, error: 'not_participant' };
      const article = msg.article;
      // No-op unless the tail still matches — if the move was already rejected
      // (illegal) or superseded, there's nothing of this article's to remove.
      if (rp.path.length > 1 && normalizeArticle(rp.path[rp.path.length - 1]) === normalizeArticle(article)) {
        const undone = rp.path.pop();
        // Keep distances index-aligned with the (now shorter) path.
        if (rp.distances.length > rp.path.length) rp.distances.length = rp.path.length;
        // Tri: un-visit the undone article ONLY if this was the player's sole
        // visit to it. If the same target still appears earlier in the remaining
        // path, they legitimately reached it before (a re-visit was undone) and
        // must keep the checkpoint they earned.
        if (room.mode === 'tri') {
          const undoneNorm = normalizeArticle(undone);
          const stillReached = rp.path.some(a => normalizeArticle(a) === undoneNorm);
          if (!stillReached) {
            const vi = rp.visited.findIndex(v => normalizeArticle(v) === undoneNorm);
            if (vi !== -1) rp.visited.splice(vi, 1);
          }
        }
        broadcastToRoom(player.roomCode, {
          type: 'player_progress',
          playerId, name: rp.name, color: rp.color,
          steps: rp.path.length, currentArticle: rp.path[rp.path.length - 1],
          visited: rp.visited.length, mode: room.mode,
        });
      }
      return { ok: true };
    }

    case 'mk_request_next': {
      // Client asks for a target. Sent once right after game_start (for the
      // first target) and after every hit or skip. Server either delivers a
      // target or tells the client to retry (candidate caches still warming).
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || !room.started || room.mode !== 'marathon') return { ok: false };
      const rp = room.players.get(playerId);
      if (!rp || !rp.marathonState) return { ok: false };
      if (rp.marathonState.currentTarget) {
        // Already have one — idempotent: re-send so a reconnecting client
        // catches up without a spurious new target.
        sendSSE(playerId, {
          type: 'marathon_next_target',
          target: rp.marathonState.currentTarget,
          liveScore: computeMarathonScore(rp.marathonState.events),
        });
        return { ok: true };
      }
      const currentArticle = rp.path[rp.path.length - 1] || room.marathon.startArticle;
      const pick = await pickMarathonTarget(room, rp, currentArticle);
      if (!pick) {
        sendSSE(playerId, { type: 'marathon_next_target', target: null, reason: 'warming' });
        return { ok: true };
      }
      const target = {
        title: pick.title,
        hops: pick.hops,
        score: pick.score,
        shownAtStep: rp.path.length - 1,
      };
      rp.marathonState.currentTarget = target;
      rp.marathonState.usedTitles.add(normalizeArticle(pick.title));
      // First real target delivered. If the round clock was deferred while the
      // candidate pool warmed (degraded 429 path), start it now and broadcast the
      // corrected deadline so warming didn't cost the player any round time.
      if (room.marathon && !room.marathon.timerStarted) {
        startMarathonClock(room, player.roomCode, { reanchor: true, broadcast: true });
      }
      sendSSE(playerId, {
        type: 'marathon_next_target',
        target,
        liveScore: computeMarathonScore(rp.marathonState.events),
      });
      // Broadcast a player_progress so peers learn this player's new target.
      // Marathon's pill bar uses this to filter who's visible (only show
      // players with the same target as you, plus yourself).
      broadcastToRoom(player.roomCode, {
        type: 'player_progress',
        playerId,
        name: rp.name,
        color: rp.color,
        steps: rp.path.length,
        currentArticle: rp.path[rp.path.length - 1] || room.marathon.startArticle,
        visited: rp.visited.length,
        mode: 'marathon',
        target: target.title,
      });
      return { ok: true };
    }

    case 'mk_skip': {
      // Player chose to skip the current target. Records a skip event and
      // pushes a new target via the same pick pipeline.
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || !room.started || room.mode !== 'marathon') return { ok: false };
      const rp = room.players.get(playerId);
      if (!rp || !rp.marathonState || !rp.marathonState.currentTarget) return { ok: false };

      const skipped = rp.marathonState.currentTarget;
      // Record clicks taken on this target before skipping — the result
      // screen uses it to place the skip pill at the right path position.
      const skipClicks = Math.max(0, rp.path.length - 1 - skipped.shownAtStep);
      rp.marathonState.events.push({ kind: 'skip', title: skipped.title, clicks: skipClicks });
      rp.marathonState.currentTarget = null;

      const currentArticle = rp.path[rp.path.length - 1] || room.marathon.startArticle;
      const pick = await pickMarathonTarget(room, rp, currentArticle);
      if (!pick) {
        sendSSE(playerId, {
          type: 'marathon_next_target',
          target: null,
          reason: 'warming',
          liveScore: computeMarathonScore(rp.marathonState.events),
        });
        return { ok: true };
      }
      const target = {
        title: pick.title,
        hops: pick.hops,
        score: pick.score,
        shownAtStep: rp.path.length - 1,
      };
      rp.marathonState.currentTarget = target;
      rp.marathonState.usedTitles.add(normalizeArticle(pick.title));
      sendSSE(playerId, {
        type: 'marathon_next_target',
        target,
        liveScore: computeMarathonScore(rp.marathonState.events),
      });
      // Same broadcast as mk_request_next: peers need to see the new target
      // to keep the same-target-only filter on the player pill bar correct.
      broadcastToRoom(player.roomCode, {
        type: 'player_progress',
        playerId,
        name: rp.name,
        color: rp.color,
        steps: rp.path.length,
        currentArticle: rp.path[rp.path.length - 1] || room.marathon.startArticle,
        visited: rp.visited.length,
        mode: 'marathon',
        target: target.title,
      });
      return { ok: true };
    }

    case 'play_again': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false };
      // Cancel any leftover marathon end-of-round timer from the prior round.
      // Without this, the SP path below overwrites room.marathon and the
      // stale timer fires later, broadcasting a game_over for the WRONG round.
      clearMarathonTimers(room.marathon);
      room.marathon = null;
      for (const [, p] of room.players) p.marathonState = null;
      if (room.singlePlayer) {
        // Single player: start immediately
        room.manualArticles = null;
        startGameForRoom(room, player.roomCode);
      } else {
        // Multiplayer: go back to lobby for word preview
        room.started = false;
        room.manualArticles = null;
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

    case 'update_daily_name': {
      // Late name update — fires after the result screen prompts the user.
      // Allows updating only the entry tied to this player's anonId.
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || !room.daily || !room.dailyAnonId || !room.dailyMeta) {
        return { ok: false, error: 'No active daily room' };
      }
      const newName = (msg.name || '').toString().slice(0, MAX_NAME_LEN).trim() || 'Anonymous';
      room.dailyName = newName;
      const board = dailyLeaderboards.get(room.dailyMeta.date);
      if (board) {
        const entry = board.find(e => e.anonId === room.dailyAnonId);
        if (entry) entry.name = newName;
      }
      return { ok: true };
    }

    case 'start_daily': {
      // Daily challenge: same A→B for everyone today, classic mode, locked
      // to today's puzzle (client-supplied origin/destination ignored).
      const daily = getDailyChallenge();
      if (!daily) return { ok: false, error: 'Daily challenge not available' };
      // Warm caches so fake leaderboard paths use real Wikipedia link data.
      // No-op if already warm; runs once per (date, server-process).
      warmDailyLinkCaches(daily);
      const code = generateRoomCode();
      const name = (msg.name || 'Anonymous').toString().slice(0, MAX_NAME_LEN);
      // Stable per-browser identity for leaderboard dedup. Falls back to a
      // server-generated id if client didn't send one (locks down only for
      // the duration of this game; no cross-day enforcement in that case).
      const anonId = (msg.anonId || crypto.randomBytes(8).toString('hex')).toString().slice(0, MAX_ANONID_LEN);
      // Country detection runs in the background — don't block the game start
      // on a geo lookup. The result lands on the room before game_over fires
      // (typical games last >1s, lookup completes in <1.5s).
      const country = req ? await Promise.race([
        getCountryForReq(req),
        new Promise(r => setTimeout(() => r(null), COUNTRY_LOOKUP_TIMEOUT_MS)),
      ]).catch(() => null) : null;
      const player = players.get(playerId);
      if (player) { player.name = name; player.roomCode = code; }
      const room = initRoom(code, playerId, name, 'en');
      room.singlePlayer = true;
      room.daily = true;
      room.dailyMeta = { date: daily.date, dailyNumber: daily.dailyNumber };
      room.dailyAnonId = anonId;
      room.dailyName = name;
      room.dailyCountry = country; // null if undetectable; client just hides flag
      room.mode = 'classic';
      // Lock to "all articles" difficulty — daily must be identical for all
      // players, so we pin to the most permissive viewRange.
      room.viewRange = parseViewRange(null);
      room.manualArticles = { origin: daily.origin, destination: daily.destination };
      rooms.set(code, room);
      sendSSE(playerId, {
        type: 'room_created', code, playerId, singlePlayer: true, lang: 'en',
        daily: true, dailyMeta: room.dailyMeta,
      });
      startGameForRoom(room, code);
      return { ok: true, code, daily: room.dailyMeta };
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
      room.mode = msg.mode === 'tri' ? 'tri' : msg.mode === 'marathon' ? 'marathon' : 'classic';
      const parsedRange = parseViewRange(msg.viewRange);
      if (parsedRange) room.viewRange = parsedRange;
      // Marathon mode: accept duration override from client.
      if (room.mode === 'marathon' && MARATHON_DURATIONS_MS[msg.duration]) {
        room.marathonDurationKey = msg.duration;
      }
      // Apply manual articles if provided (validated). Marathon generates
      // all words server-side so it doesn't accept manual input.
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
      // Marathon has no surrender — the round ends on the timer. Reject any
      // stale/malicious give_up_vote so finalizeGiveUp doesn't broadcast a
      // non-marathon-shaped game_over for a marathon room AND leave the
      // marathon end-of-round timer scheduled.
      if (room.mode === 'marathon') return { ok: false, error: 'Marathon has no surrender' };

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
      // Host-only — guests sending this should not be able to reset the room.
      // Mirrors the existing `play_again` host check (around line ~2190).
      if (room.host !== playerId) return { ok: false, error: 'Only host can return to lobby' };

      // Reset room state but keep players connected
      room.started = false;
      room.startTime = null;
      room.winner = null;
      room.pair = null;
      room.triple = null;
      room.giveUpVotes.clear();
      room.destData = null;
      // Cancel the marathon end-of-round timer if it was scheduled — otherwise
      // it fires later and broadcasts a stale `game_over` to the lobby.
      clearMarathonTimers(room.marathon);
      room.marathon = null;
      for (const [, p] of room.players) {
        Object.assign(p, { path: [], finished: false, finishTime: null, visited: [], distances: [] });
        // Clear per-player marathon state so a stale `mk_request_next` from a
        // racing client hits a clean slate.
        p.marathonState = null;
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
  if (room.daily) submitDailyToLeaderboard(room, true);
  broadcastToRoom(roomCode, {
    type: 'game_over',
    gaveUp: true,
    results,
    mode: room.mode,
    // Guard against `room.triple` being null when surrender fires before
    // generation completes (Wikipedia error path can leave started=false +
    // triple=null). Avoids "Cannot read properties of null" throws.
    targets: room.mode === 'tri' ? (room.triple?.targets || null) : null,
    daily: !!room.daily,
    dailyMeta: room.dailyMeta || null,
  });
  recordRoomEvent(room, roomCode, 'game_over', { mirror: true, mode: room.mode, lang: room.lang || DEFAULT_LANG, meta: { gaveUp: true } });
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
  // Defensive: keep the "every teardown clears marathon timers" invariant so a
  // deferred-clock fallback can't outlive the round (no-op for non-marathon and
  // currently unreachable for marathon, but cheap insurance if that changes).
  clearMarathonTimers(room.marathon);
}

function handleDisconnect(playerId) {
  const player = players.get(playerId);
  if (!player) return;
  const roomCode = player.roomCode;
  players.delete(playerId);
  // Release their recent-picks + rate-limit memory so the maps don't grow forever.
  recentPicks.delete(playerId);
  actionBuckets.delete(playerId);

  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.delete(playerId);
  // Remove their give-up vote too — otherwise a stale vote against a now-
  // shrunken player count could falsely meet the threshold (e.g. A votes,
  // A disconnects, B votes → 2/2 ends game even though C never voted).
  room.giveUpVotes?.delete(playerId);

  if (room.players.size === 0) {
    // Drop any live marathon timer before GC so it doesn't fire against a
    // deleted room (noop in practice but keeps the process clean under load).
    clearMarathonTimers(room.marathon);
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
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      body += chunk;
      if (body.length > 1e6) {     // ~1MB cap; tear down so we stop buffering a
        done = true;               // hostile/slow stream after the limit is hit
        req.destroy();
        reject(new Error('Too large'));
      }
    });
    req.on('end', () => { if (!done) resolve(body); });
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

  // Daily leaderboard for a given date (default: today). Public, anonymous,
  // capped at 25 entries. Cache-Control: no-store so each result-screen view
  // gets the freshest standings.
  if (parsed.pathname === '/daily/leaderboard' && req.method === 'GET') {
    let date = (parsed.query.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.query.date))
      ? parsed.query.date
      : utcDateStr();
    // Clamp to [launch, today]. Fixed-width YYYY-MM-DD compares lexically, so
    // this is a safe string clamp — and it stops out-of-range dates (no board
    // exists for the future or before launch) from reaching the day-walk.
    const today = utcDateStr();
    if (date > today) date = today;
    else if (date < DAILY_LAUNCH_DATE) date = DAILY_LAUNCH_DATE;
    const entries = getLeaderboard(date);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ date, entries, count: entries.length }));
    return;
  }

  // Client-side error reporting. The browser posts uncaught errors / unhandled
  // rejections here so they land in the same structured Railway logs (and
  // Discord) as server crashes — closing the previously-invisible client blind
  // spot, dependency-free. Per-IP rate-limited, noise-filtered, size-capped, and
  // it never errors back (a logging endpoint must not become a failure source).
  if (parsed.pathname === '/clientlog' && req.method === 'POST') {
    if (!allowClientLog(clientIpFromReq(req))) { res.writeHead(429); res.end(); return; }
    try {
      const data = JSON.parse(await readBody(req));
      const message = String(data.message || '').slice(0, 300);
      if (!isNoiseClientError(message)) {
        const kind = data.kind === 'client_unhandledrejection' ? 'client_unhandledrejection' : 'client_error';
        const info = {
          message,
          stack: data.stack ? String(data.stack).slice(0, 1200) : null,
          source: data.source ? String(data.source).slice(0, 300) : null,
          line: Number.isFinite(data.lineno) ? data.lineno : null,
          path: data.url ? String(data.url).slice(0, 200) : null,
          ua: (req.headers['user-agent'] || '').slice(0, 200),
        };
        logEvent(kind, info);
        // Dedupe by message + source:line so one recurring client bug pings once.
        notifyDiscord('🟠', kind, `${kind}|${info.message}|${info.source || ''}:${info.line || ''}`,
          `${info.message}\n${info.stack || ''}\n@ ${info.path || '?'} · ${info.ua}`);
      }
    } catch (_) { /* malformed report — ignore, never error a logging endpoint */ }
    res.writeHead(204);
    res.end();
    return;
  }

  // Page-view beacon. Fired client-side on every page load (first-party, so ad
  // blockers don't touch it), this counts EVERY visitor server-side — including
  // bouncers who never start a game and so never open an SSE stream / fire a
  // 'visit'. Public + unauthenticated: per-IP rate-limited, validated, and it
  // never errors back (a logging endpoint must not become a failure source).
  if (parsed.pathname === '/pageview' && req.method === 'POST') {
    if (!allowPageview(clientIpFromReq(req))) { res.writeHead(429); res.end(); return; }
    // Accept the beacon but don't record bots — keeps the headcount human.
    if (isBotUA(req.headers['user-agent'])) { res.writeHead(204); res.end(); return; }
    try {
      const data = JSON.parse(await readBody(req));
      const visitorId = sanitizeVid(data.vid);
      const gaClientId = sanitizeGaClientId(data.gacid) || visitorId;
      const page = typeof data.page === 'string' ? data.page.slice(0, 200) : null;
      // Each self-gates on its own id; recordEvent needs a vid, sendGA4 a clientId.
      recordEvent('page_view', { visitorId, meta: page ? { page } : null });
      sendGA4({ clientId: gaClientId, name: 'page_view', params: {} });
    } catch (_) { /* malformed — ignore, never error a logging endpoint */ }
    res.writeHead(204);
    res.end();
    return;
  }

  // Backlink validation for the destination word-box (Bug 3): lets the client
  // warn at type-time that an article is too isolated to be a playable target,
  // instead of only finding out after pressing Start. Backed by the same
  // countBacklinks the runtime guardrail uses (redirect/variant-resolving,
  // 7-day cached, fail-open). Outbound load is bounded by the global request
  // limiter; results are cached so repeated checks are cheap.
  if (parsed.pathname === '/validate-dest' && req.method === 'GET') {
    const title = parsed.query.title;
    const lang = normalizeLang(parsed.query.lang);
    if (!title || !isValidArticle(title)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_title' }));
      return;
    }
    const MIN = 15;
    const count = await countBacklinks(title, MIN, lang);
    // null = couldn't determine → not sparse (fail open; never block on our hiccup).
    const sparse = count !== null && count < MIN;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, sparse, count, threshold: MIN }));
    return;
  }

  // Today's daily challenge as JSON. Used by the home screen to show the
  // "Daily Challenge #N: A → B" preview without forcing the client to also
  // know the puzzle pool. Cached for 5 min — same puzzle for 24h, but a
  // shorter cache lets us push a hot-fix to the picker without 24h drag.
  if (parsed.pathname === '/daily') {
    const c = getDailyChallenge();
    if (!c) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'pool_not_loaded' }));
      return;
    }
    // Warm link caches in the background — by the time someone fetches
    // /daily/leaderboard, the fakes will use real link data.
    warmDailyLinkCaches(c);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(JSON.stringify(c));
    return;
  }

  // Healthcheck for Railway (and any other uptime probe). Returns 200
  // only when puzzle pools have actually loaded — protects against the
  // edge case where the HTTP server starts listening before the pool
  // load completes (currently synchronous, but cheap insurance if that
  // ever becomes async). Intentionally tiny + unlogged so probe traffic
  // doesn't pollute access logs at 1 req/s.
  if (parsed.pathname === '/health') {
    const loadedLangs = Object.keys(puzzlePools).filter(l => puzzlePools[l]?.pairs?.length > 0);
    const ready = loadedLangs.length > 0 && !!indexHtmlRaw;
    const body = JSON.stringify({
      status: ready ? 'ok' : 'starting',
      uptime: Math.floor(process.uptime()),
      pools: loadedLangs,
    });
    res.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    // Honor If-None-Match: send 304 instead of re-shipping the body when
    // the client has the same version cached. Saves ~265KB raw / ~50KB gz
    // on every revisit within the cache window.
    if (req.headers['if-none-match'] === indexHtmlEtag) {
      res.writeHead(304, { 'ETag': indexHtmlEtag, 'Cache-Control': 'public, max-age=60, must-revalidate' });
      res.end();
      return;
    }
    // Pick best encoding the client advertises. Brotli > gzip > identity.
    const ae = (req.headers['accept-encoding'] || '').toLowerCase();
    let body, encoding;
    if (ae.includes('br')) { body = indexHtmlBr; encoding = 'br'; }
    else if (ae.includes('gzip')) { body = indexHtmlGz; encoding = 'gzip'; }
    else { body = indexHtmlRaw; encoding = null; }
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'ETag': indexHtmlEtag,
      // 60s freshness, then mandatory revalidation. Combined with ETag, a
      // returning visitor pays at most a 304 (no body) on stale-revalidate.
      // Short enough that pushed updates reach users within a minute.
      'Cache-Control': 'public, max-age=60, must-revalidate',
      'Vary': 'Accept-Encoding',
    };
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers);
    res.end(body);
    return;
  }

  // Self-hosted DOMPurify (see loadPurify). Served from memory with gzip
  // negotiation + ETag, mirroring the index route.
  if (parsed.pathname === '/purify.min.js') {
    if (req.headers['if-none-match'] === purifyEtag) {
      res.writeHead(304, { 'ETag': purifyEtag, 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }
    const useGz = (req.headers['accept-encoding'] || '').toLowerCase().includes('gzip');
    const body = useGz ? purifyGz : purifyRaw;
    const headers = {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': body.length,
      'ETag': purifyEtag,
      'Cache-Control': 'public, max-age=86400',
      'Vary': 'Accept-Encoding',
    };
    if (useGz) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(body);
    return;
  }

  if (parsed.pathname === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    // Guard the stream: an unhandled 'error' on a piped Readable (missing file,
    // permission flip mid-deploy) would otherwise throw and crash the process.
    fs.createReadStream(path.join(__dirname, 'favicon.svg'))
      .on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); })
      .pipe(res);
    return;
  }

  // og:image for link-preview cards (iMessage, Slack, WhatsApp, Discord,
  // Twitter, Facebook). Referenced by the <meta property="og:image"> tag
  // in index.html. Kept as a plain route so the URL stays clean and
  // crawler-friendly — no /static/ prefix to remember.
  if (parsed.pathname === '/preview.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(path.join(__dirname, 'preview.png'))
      .on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); })
      .pipe(res);
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
    // Persistent per-browser visitor id (see analytics section). Validated;
    // null if absent/malformed. Bound to the player record below so every
    // server-side event can resolve the human behind a session.
    const visitorId = sanitizeVid(parsed.query.vid);
    // GA's own client id, captured client-side only when gtag wasn't blocked.
    // Preferred as the GA4 client_id so non-blocked users stitch to their
    // existing GA identity; falls back to the vid for blocked users.
    const gaClientId = sanitizeGaClientId(parsed.query.gacid) || visitorId;
    // A GENUINE reconnect proves ownership of an existing session with the
    // matching reconnect token — NOT just the playerId, which is broadcast to
    // every room member via player_list/progress and so is public. Rebinding
    // and the capacity bypass both hinge on this: an opponent who only knows
    // your playerId must not be able to take over your SSE handle (and be
    // handed your CSRF token), nor slip past the connection cap.
    let existing = players.get(playerId);
    const isGenuineReconnect = !!(existing && parsed.query.rt && parsed.query.rt === existing.reconnectToken);

    // Capacity cap: any request that will create a NEW players record — a fresh
    // connect OR a known id replayed WITHOUT the right token — counts against
    // the ceiling. Only genuine reconnects bypass it, so a flood replaying
    // known ids can't grow the Map (and its sockets) past the limit.
    if (!isGenuineReconnect && players.size >= MAX_SSE_CONNECTIONS) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '10' });
      res.end('Server at capacity — please try again shortly.');
      return;
    }
    if (!isGenuineReconnect && existing) {
      // Known playerId without the matching secret — do NOT touch the real
      // owner's record. Start a brand-new session instead.
      playerId = generatePlayerId();
      existing = undefined;
    }
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
    const newCsrfToken = crypto.randomBytes(16).toString('hex');
    const newReconnectToken = crypto.randomBytes(16).toString('hex');
    const connectedAt = Date.now();

    // Reconnect path. Two scenarios both rebind to preserve room state:
    //   (a) Pending grace: SSE dropped, EventSource auto-reconnected within
    //       30s. pendingDisconnects has a timer to cancel.
    //   (b) Proactive recycle: client opened a NEW SSE while the old one is
    //       still technically alive (used to pre-empt platform timeouts like
    //       Railway's 15-min request cap — without this the SSE silently dies
    //       mid-game, EventSource may not reconnect cleanly under tab-bg/
    //       sleep, and the player loses their room).
    // Either way, swap the res handle on the existing player record instead
    // of allocating a fresh one with roomCode=null.
    const pendingTid = pendingDisconnects.get(playerId);
    let activeCsrf = newCsrfToken;
    let activeReconnect = newReconnectToken;
    if (existing) {
      if (pendingTid) {
        clearTimeout(pendingTid);
        pendingDisconnects.delete(playerId);
      }
      // Best-effort close of the old SSE handle. Its req.on('close') will
      // fire but our guard below skips cleanup since cur.res !== oldRes.
      try { existing.res?.end?.(); } catch (_) {}
      existing.res = res;
      // KEEP the existing CSRF + reconnect tokens, don't rotate. During
      // proactive recycle the client may have action requests in flight signed
      // with the old token between opening the new SSE and processing
      // 'connected'. Rotating would 403 those (subtle "lost click" bug).
      activeCsrf = existing.csrfToken;
      activeReconnect = existing.reconnectToken;
      existing.connectedAt = connectedAt;
      // Fill the id bindings only if MISSING — never change an id mid-session, or
      // this browser's events would split across two ids and double-count the
      // human. And do NOT record a 'visit': reconnects (incl. the 10-min
      // proactive recycle) are the same human, not a new one.
      if (visitorId && !existing.visitorId) existing.visitorId = visitorId;
      if (gaClientId && !existing.gaClientId) existing.gaClientId = gaClientId;
      console.log(`SSE reconnected: ${playerId.slice(0, 8)} (room: ${existing.roomCode || 'none'}, mode: ${pendingTid ? 'grace' : 'proactive'})`);
      logEvent('sse_reconnect', { playerId, roomCode: existing.roomCode || null, mode: pendingTid ? 'grace' : 'proactive', totalConnected: players.size });
    } else {
      players.set(playerId, { res, roomCode: null, name: null, csrfToken: newCsrfToken, reconnectToken: newReconnectToken, connectedAt, visitorId, gaClientId });
      console.log(`SSE connected: ${playerId.slice(0, 8)} (total: ${players.size})`);
      logEvent('sse_connect', { playerId, totalConnected: players.size });
      // A fresh player record = a new session = one 'visit'. Source of truth in
      // Postgres (keyed by vid); mirrored to GA4 (keyed by gaClientId) so ad-
      // blocked users still register. Each call self-gates on its own id. Skip
      // bots so they don't inflate the headcount.
      if (!isBotUA(req.headers['user-agent'])) {
        recordEvent('visit', { visitorId, playerId });
        sendGA4({ clientId: gaClientId, name: 'visit', params: {} });
      }
    }

    sendSSE(playerId, { type: 'connected', playerId, csrfToken: activeCsrf, reconnectToken: activeReconnect });

    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      // If a newer SSE has already replaced our res handle, do nothing — the
      // close fired because we're the *old* connection getting evicted by a
      // reconnect (see rebind above).
      const cur = players.get(playerId);
      if (cur && cur.res !== res) return;
      const sessionMs = cur?.connectedAt ? Date.now() - cur.connectedAt : null;
      console.log(`SSE disconnected: ${playerId.slice(0, 8)} (grace ${DISCONNECT_GRACE_MS}ms)`);
      logEvent('sse_disconnect', { playerId, roomCode: cur?.roomCode || null, sessionMs });
      // Defer cleanup so a quick auto-reconnect can reattach. If they don't
      // come back in time, run the original teardown.
      const tid = setTimeout(() => {
        // Detached timer: a throw here has no caller to catch it and would route
        // through uncaughtException → 🔴 crash alert. Log it as handled instead.
        try {
          pendingDisconnects.delete(playerId);
          handleDisconnect(playerId);
        } catch (e) {
          logEvent('disconnect_cleanup_error', { playerId, message: e && e.message });
        }
      }, DISCONNECT_GRACE_MS);
      pendingDisconnects.set(playerId, tid);
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
      // Late-bind the visitor id from the action body if the SSE connect didn't
      // carry one (e.g. a session opened before this shipped). Connect-time
      // binding stays authoritative; this only fills a gap.
      if (!player.visitorId && msg && msg.vid) {
        const v = sanitizeVid(msg.vid);
        if (v) player.visitorId = v;
      }
      if (!allowAction(playerId)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
        return;
      }
      const result = await handleAction(playerId, msg, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result || { ok: true }));
    } catch (e) {
      // Log the full error server-side, but don't leak exception/parse details
      // (which can reveal internals) to the client.
      console.error('Action error:', e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
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
  // Backlink helpers — generatePool.js's sparse-destination guardrail imports
  // getBacklinks; without these exports the require returned undefined and the
  // guardrail silently no-op'd, letting sparse articles (1win, Raindrop_cake)
  // into the pool.
  getBacklinks,
  countBacklinks,
  getDailyChallenge,
  HARDCODED_DAILY_BLACKLIST,
  WIKI_HOSTS,
  DEFAULT_LANG,
  // Marathon scoring (pure — safe to unit test)
  marathonBasePoints,
  marathonCompletionBonus,
  computeMarathonScore,
  MARATHON_DURATIONS_MS,
};
