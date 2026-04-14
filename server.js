const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── Game State ───
const rooms = new Map();
const players = new Map(); // playerId -> { res (SSE), roomCode, name }

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
}

function generatePlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Curated Word Pairs ───
const WORD_PAIRS = [
  { origin: 'Pizza', destination: 'Ancient_Egypt' },
  { origin: 'Football', destination: 'Moon' },
  { origin: 'Banana', destination: 'Albert_Einstein' },
  { origin: 'Guitar', destination: 'World_War_II' },
  { origin: 'Cat', destination: 'Philosophy' },
  { origin: 'Coffee', destination: 'Mathematics' },
  { origin: 'Bicycle', destination: 'Napoleon' },
  { origin: 'Chocolate', destination: 'Japan' },
  { origin: 'Shark', destination: 'Internet' },
  { origin: 'Diamond', destination: 'Shakespeare' },
  { origin: 'Volcano', destination: 'Democracy' },
  { origin: 'Piano', destination: 'Amazon_rainforest' },
  { origin: 'Penguin', destination: 'Olympic_Games' },
  { origin: 'Bread', destination: 'Artificial_intelligence' },
  { origin: 'Tiger', destination: 'Electricity' },
  { origin: 'Sushi', destination: 'Leonardo_da_Vinci' },
  { origin: 'Mars', destination: 'Dog' },
  { origin: 'Yoga', destination: 'Roman_Empire' },
  { origin: 'Ice_cream', destination: 'Quantum_mechanics' },
  { origin: 'Tornado', destination: 'Cleopatra' },
];

function getRandomPair() {
  return WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
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
function handleAction(playerId, msg) {
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
      rooms.set(code, {
        host: playerId,
        players: new Map([[playerId, { name, path: [], finished: false, finishTime: null }]]),
        pair: null,
        started: false,
        startTime: null,
        winner: null,
      });
      sendSSE(playerId, { type: 'room_created', code, playerId });
      broadcastToRoom(code, {
        type: 'player_list',
        players: [...rooms.get(code).players.entries()].map(([id, p]) => ({ id, name: p.name })),
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
      if (player) {
        player.name = name;
        player.roomCode = code;
      }
      room.players.set(playerId, { name, path: [], finished: false, finishTime: null });
      sendSSE(playerId, { type: 'room_joined', code, playerId });
      broadcastToRoom(code, {
        type: 'player_list',
        players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name })),
        host: room.host,
      });
      return { ok: true };
    }

    case 'start_game': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false, error: 'Only host can start' };
      if (room.players.size < 2) return { ok: false, error: 'Need at least 2 players' };

      room.pair = getRandomPair();
      room.started = true;
      room.startTime = Date.now();
      room.winner = null;
      for (const [, p] of room.players) {
        p.path = [room.pair.origin];
        p.finished = false;
        p.finishTime = null;
      }
      broadcastToRoom(player.roomCode, {
        type: 'game_start',
        origin: room.pair.origin,
        destination: room.pair.destination,
      });
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
      if (!article) return { ok: false };
      rp.path.push(article);

      broadcastToRoom(player.roomCode, {
        type: 'player_progress',
        playerId,
        name: rp.name,
        steps: rp.path.length,
        currentArticle: article,
      });

      // Check win
      const dest = room.pair.destination.replace(/_/g, ' ').toLowerCase();
      const current = article.replace(/_/g, ' ').toLowerCase();
      if (current === dest) {
        rp.finished = true;
        rp.finishTime = Date.now() - room.startTime;
        if (!room.winner) {
          room.winner = playerId;
          const results = [...room.players.entries()].map(([id, p]) => ({
            id, name: p.name, path: p.path,
            finished: p.finished, time: p.finishTime,
            isWinner: id === room.winner,
          }));
          broadcastToRoom(player.roomCode, { type: 'game_over', winner: rp.name, results });
          room.started = false;
        }
      }
      return { ok: true };
    }

    case 'play_again': {
      const player = players.get(playerId);
      if (!player) return { ok: false };
      const room = rooms.get(player.roomCode);
      if (!room || room.host !== playerId) return { ok: false };

      room.pair = getRandomPair();
      room.started = true;
      room.startTime = Date.now();
      room.winner = null;
      for (const [, p] of room.players) {
        p.path = [room.pair.origin];
        p.finished = false;
        p.finishTime = null;
      }
      broadcastToRoom(player.roomCode, {
        type: 'game_start',
        origin: room.pair.origin,
        destination: room.pair.destination,
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
      players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name })),
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Player-Id');
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  cors(res);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve HTML
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  // SSE endpoint
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
    res.write('\n'); // flush headers

    // Register player
    players.set(playerId, { res, roomCode: null, name: null });
    console.log(`SSE connected: ${playerId.slice(0, 8)} (total: ${players.size})`);

    // Send the player their ID
    sendSSE(playerId, { type: 'connected', playerId });

    // Keepalive ping every 15s
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

  // Action endpoint
  if (parsed.pathname === '/action' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const msg = JSON.parse(body);
      const playerId = req.headers['x-player-id'];
      if (!playerId || !players.has(playerId)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not connected. Open /events first.' }));
        return;
      }
      const result = handleAction(playerId, msg);
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
