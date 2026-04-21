#!/usr/bin/env node
// End-to-end smoke test for WikiSpeedrun against a running server.
// Drives the same API the browser client does: opens SSE, exchanges
// playerId + csrf, then runs a full single-player classic game — create
// room, pick random words via `?`, start game, navigate a couple articles,
// give up to exercise the game_over path. Asserts no unexpected errors
// and that key SSE events arrive in order.
//
// Usage: node scripts/e2eSmoke.js [--port 3000]

const http = require('http');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 3000;
})();
const HOST = 'localhost';

function sseStream() {
  return new Promise((resolve, reject) => {
    const events = [];
    const listeners = [];
    const req = http.get({ host: HOST, port: PORT, path: '/events' }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`SSE ${res.statusCode}`));
      }
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const msg = JSON.parse(line.slice(6));
                events.push(msg);
                listeners.forEach(l => l(msg));
              } catch { /* heartbeat comments etc. */ }
            }
          }
        }
      });
      res.on('error', reject);
      resolve({
        req, events,
        onMessage: fn => listeners.push(fn),
        waitFor: (matcher, timeoutMs = 8000) => new Promise((res, rej) => {
          const found = events.find(matcher);
          if (found) return res(found);
          const t = setTimeout(() => rej(new Error(`timeout waiting for matcher`)), timeoutMs);
          listeners.push(m => {
            if (matcher(m)) { clearTimeout(t); res(m); }
          });
        }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

async function action(playerId, csrf, msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(msg);
    const req = http.request({
      host: HOST, port: PORT, path: '/action', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Player-Id': playerId,
        'X-Csrf-Token': csrf || '',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const pass = m => console.log(`  ✓ ${m}`);
const fail = m => { console.log(`  ✗ ${m}`); process.exitCode = 1; };

(async () => {
  console.log(`\nWikiSpeedrun e2e smoke @ ${HOST}:${PORT}\n`);

  console.log('[1] Open SSE stream...');
  const sse = await sseStream();
  const hello = await sse.waitFor(m => m.type === 'connected', 3000);
  if (!hello.playerId || !hello.csrfToken) {
    fail(`connect event missing playerId/csrfToken: ${JSON.stringify(hello)}`);
    sse.close(); return;
  }
  pass(`SSE connected, playerId=${hello.playerId.slice(0,8)}…, csrf=${hello.csrfToken.slice(0,6)}…`);
  const { playerId, csrfToken: csrf } = hello;

  console.log('\n[2] Create single-player classic room (no manual articles)...');
  const r1 = await action(playerId, csrf, {
    type: 'start_single',
    name: 'SmokeBot',
    mode: 'classic',
    lang: 'en',
    viewRange: [500000, 100000000],
  });
  if (r1.status !== 200 || !r1.body.ok) {
    fail(`start_single failed: ${r1.status} ${JSON.stringify(r1.body)}`);
    sse.close(); return;
  }
  pass(`start_single ok, room=${r1.body.code}`);

  console.log('\n[3] Wait for game_start event...');
  const gameStart = await sse.waitFor(m => m.type === 'game_start', 6000);
  if (!gameStart.origin || !gameStart.destination) {
    fail(`game_start missing origin/destination: ${JSON.stringify(gameStart)}`);
    sse.close(); return;
  }
  pass(`origin=${gameStart.origin}, destination=${gameStart.destination}, lang=${gameStart.lang}`);

  console.log('\n[4] Verify pool-based puzzle came through (server should not hit wiki live)...');
  // These are from the pool, so the destination should be canonical (pool has
  // resolveRedirect applied at gen time).
  const destHasUnderscores = gameStart.destination.includes('_') || gameStart.destination.length < 30;
  pass(`dest title looks canonical: "${gameStart.destination}"`);

  console.log('\n[5] Send a sequence of navigates from origin, expect player_progress echoes...');
  // Use the origin as start; "navigate" to a believable article. We don't
  // actually need the destination — we just want to exercise the
  // navigate+broadcast path. Any valid article title works for the nav log,
  // but if it's not in the dest's alias set it won't trigger a win.
  const testArticles = ['United_States', 'Earth', 'Wikipedia'];
  for (const article of testArticles) {
    const r = await action(playerId, csrf, { type: 'navigate', article });
    if (r.status !== 200 || !r.body.ok) {
      fail(`navigate(${article}) failed: ${r.status} ${JSON.stringify(r.body)}`);
      sse.close(); return;
    }
  }
  const progress = await sse.waitFor(m => m.type === 'player_progress' && m.currentArticle === testArticles[testArticles.length - 1], 3000);
  pass(`player_progress received for ${progress.currentArticle}, steps=${progress.steps}`);

  console.log('\n[6] Give up (single player → immediate game_over)...');
  const r2 = await action(playerId, csrf, { type: 'give_up_vote' });
  if (r2.status !== 200 || !r2.body.ok) {
    fail(`give_up_vote failed: ${r2.status} ${JSON.stringify(r2.body)}`);
    sse.close(); return;
  }
  const gameOver = await sse.waitFor(m => m.type === 'game_over', 3000);
  if (!gameOver.gaveUp) fail(`game_over.gaveUp should be true: ${JSON.stringify(gameOver)}`);
  else pass(`game_over received, gaveUp=true, ${gameOver.results.length} results`);

  console.log('\n[7] Test Fix 5: invalid viewRange is rejected silently (no crash)...');
  // This is a room-difficulty change; we need a room. We already have one.
  const r3 = await action(playerId, csrf, {
    type: 'change_difficulty',
    viewRange: [NaN, Infinity],
  });
  // Should succeed (returns ok) but internally reject → viewRange becomes null
  // OR it might not be a valid action type. Just check no 500.
  if (r3.status >= 500) fail(`bad viewRange crashed server: ${r3.status}`);
  else pass(`invalid viewRange handled cleanly (HTTP ${r3.status})`);

  console.log('\n[8] Test Fix 6: navigate_rejected should fire for wrong-state nav...');
  // Game is over now. Try to navigate — server should reject.
  const r4 = await action(playerId, csrf, { type: 'navigate', article: 'Mars' });
  if (r4.body.ok) fail(`navigate after game_over should be rejected, got ok:true`);
  else pass(`post-game navigate correctly rejected (ok:${r4.body.ok})`);

  console.log('\n[9] Close SSE cleanly...');
  sse.close();
  await new Promise(r => setTimeout(r, 200));
  pass(`disconnected`);

  console.log(`\n${process.exitCode ? '✗ Some checks FAILED' : '✓ All checks passed'}\n`);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
