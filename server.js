// Tuk Tuk Madness: matchmaking and relay server
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const BAN_FILE = path.join(__dirname, 'bans.json');
const MODES = { '1v1': 2, '2v2': 4, ffa: 4, flight: 4, truck: 4 };
const MAPS = new Set(['original', 'mega', 'wrap']);
const MAX_NAME = 30;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('Tuk Tuk Madness server running');
});

const wss = new WebSocketServer({ server: httpServer });
const queues = {};
const rooms = new Map();
let roomSeq = 1;
let botSeq = 1;

const bannedNames = new Map();

function loadBans() {
  try {
    if (!fs.existsSync(BAN_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      for (const name of raw) {
        const clean = String(name || '').trim();
        if (clean) bannedNames.set(clean.toLowerCase(), clean);
      }
    }
  } catch (err) {
    console.error('Failed to load bans:', err.message);
  }
}

function saveBans() {
  try {
    fs.writeFileSync(BAN_FILE, JSON.stringify([...bannedNames.values()], null, 2));
  } catch (err) {
    console.error('Failed to save bans:', err.message);
  }
}

loadBans();

const normalizeName = name => String(name || '').trim().toLowerCase();
const isBanned = name => bannedNames.has(normalizeName(name));

const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const roomOf = ws => ws.roomId ? rooms.get(ws.roomId) : undefined;
const randomSeed = () => Math.floor(Math.random() * 1e9);

function getOnlinePlayers() {
  const list = [];
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN && !client.isObserver) {
      list.push({ id: client.playerId, name: client.name || 'Player' });
    }
  }
  return list;
}

function broadcastStateToObservers() {
  const payload = {
    type: 'tukdevState',
    players: getOnlinePlayers(),
    banned: [...bannedNames.values()]
  };
  for (const client of wss.clients) {
    if (client.isObserver) send(client, payload);
  }
}

function kickBannedClients() {
  for (const client of wss.clients) {
    if (!client.isObserver && isBanned(client.name)) {
      removeFromQueues(client);
      leaveRoom(client);
      try { client.close(); } catch (_) {}
    }
  }
}

function broadcast(room, msg, exceptId) {
  for (const p of room.players) {
    if (p.ws && p.id !== exceptId) send(p.ws, msg);
  }
}

function removeFromQueues(ws) {
  for (const key of Object.keys(queues)) {
    queues[key] = queues[key].filter(e => e.ws !== ws);
  }
}

function rosterFor(room) {
  let truckIdx = -1;
  if (room.mode === 'truck' && room.players.length) {
    truckIdx = room.truckId
      ? room.players.findIndex(p => p.id === room.truckId)
      : -1;
    if (truckIdx < 0) truckIdx = Math.floor(Math.random() * room.players.length);
  }

  const roster = room.players.map((p, idx) => {
    let team = null;
    let role = 'player';

    if (room.mode === '2v2') {
      team = idx < Math.ceil(room.players.length / 2) ? 'blue' : 'orange';
    }

    if (room.mode === 'truck') {
      const isTruck = idx === truckIdx;
      team = isTruck ? 'truck' : 'tuks';
      role = isTruck ? 'truck' : 'tuk';
    }

    return { id: p.id, name: p.name, bot: !!p.bot, team, role };
  });

  if (room.mode === 'truck') {
    const t = roster.find(r => r.role === 'truck');
    room.truckId = t ? t.id : null;
  }

  return roster;
}

function createRoom(mode, entries, map) {
  const id = 'room' + roomSeq++;
  const room = {
    id, mode, map: MAPS.has(map) ? map : 'original',
    players: [], rematch: new Set(),
    truckId: null, over: false
  };

  entries.forEach((entry, idx) => {
    const team = mode === '2v2' ? (idx < 2 ? 'blue' : 'orange') : null;

    if (entry.bot) {
      room.players.push({
        id: 'bot-' + botSeq++,
        name: entry.name,
        team,
        ws: null,
        bot: true
      });
    } else {
      room.players.push({
        id: entry.ws.playerId,
        name: entry.name,
        team,
        ws: entry.ws
      });
      entry.ws.roomId = id;
    }
  });

  rooms.set(id, room);
  const roster = rosterFor(room);
  const seed = randomSeed();

  for (const p of room.players) {
    send(p.ws, {
      type: 'matchFound',
      roomId: id,
      mode,
      map: room.map,
      you: p.id,
      team: p.team,
      roster,
      seed
    });

    for (const other of room.players) {
      if (other.id !== p.id && other.skin) {
        send(p.ws, { type: 'skin', id: other.id, ...other.skin });
      }
    }
  }
}

function endRound(room, winner, reason) {
  if (room.over) return;
  room.over = true;
  broadcast(room, { type: 'roundEnd', winner, reason });
}

function notifyCustomRoom(room) {
  if (!room || !room.custom) return;

  const roster = rosterFor(room);
  for (const p of room.players) {
    send(p.ws, {
      type: 'customRoomUpdate',
      roomCode: room.code,
      hostId: room.ownerId,
      you: p.id,
      mode: room.mode,
      map: room.map,
      maxPlayers: room.maxPlayers,
      roster
    });
  }
}

function customRoomList() {
  return [...rooms.values()]
    .filter(r => r.custom && r.status === 'lobby')
    .map(r => ({
      code: r.code,
      mode: r.mode,
      map: r.map,
      players: r.players.length,
      maxPlayers: r.maxPlayers,
      host: (r.players.find(p => p.id === r.ownerId) || {}).name || 'Host'
    }));
}

function broadcastCustomRoomList() {
  const payload = { type: 'customRooms', rooms: customRoomList() };
  for (const client of wss.clients) send(client, payload);
}

function leaveRoom(ws) {
  const room = roomOf(ws);
  if (!room) return;

  if (room.custom && room.status === 'lobby' && ws.playerId === room.ownerId) {
    for (const p of room.players) {
      if (p.ws) p.ws.roomId = null;
      if (p.ws !== ws) send(p.ws, { type: 'customRoomClosed' });
    }
    rooms.delete(room.id);
    ws.roomId = null;
    broadcastCustomRoomList();
    return;
  }

  const wasTruck = room.mode === 'truck' && room.truckId === ws.playerId;
  room.players = room.players.filter(p => p.ws !== ws);
  room.rematch.delete(ws.playerId);
  ws.roomId = null;

  broadcast(room, { type: 'playerLeft', id: ws.playerId });

  if (room.custom) {
    if (room.players.length === 0) rooms.delete(room.id);
    else notifyCustomRoom(room);
    broadcastCustomRoomList();
    return;
  }

  if (room.mode === 'truck' && !room.over) {
    if (wasTruck) {
      endRound(room, 'tuks', 'The truck left the match');
    } else if (!room.players.some(p => p.id !== room.truckId)) {
      endRound(room, 'truck', 'All the tuks left the match');
    }
  }

  if (!room.players.some(p => !p.bot)) rooms.delete(room.id);
}

function tryStart(key) {
  const mode = key.split('|')[0];
  const map = key.split('|')[1];
  const need = MODES[mode];
  const q = queues[key];
  if (!q || q.length < need) return;
  createRoom(mode, q.splice(0, need), map);
}

function joinQueue(ws, mode, map) {
  if (isBanned(ws.name)) {
    try { ws.close(); } catch (_) {}
    return;
  }

  if (!MODES[mode]) return;
  if (roomOf(ws)) leaveRoom(ws);

  const mapName = MAPS.has(map) ? map : 'original';
  const key = mode + '|' + mapName;

  removeFromQueues(ws);
  if (!queues[key]) queues[key] = [];
  queues[key].push({ ws, name: ws.name });
  send(ws, { type: 'queued', mode, map: mapName, waiting: queues[key].length });
  tryStart(key);
}

const CUSTOM_MODES = new Set(['1v1', '2v2', 'ffa', 'flight', 'truck']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while ([...rooms.values()].some(r => r.custom && r.code === code));
  return code;
}

function customRoomCreate(ws, m) {
  if (isBanned(ws.name)) return;

  const mode = CUSTOM_MODES.has(m.mode) ? m.mode : 'ffa';
  const maxPlayers = Math.max(2, Math.min(16, Math.floor(Number(m.maxPlayers) || 2)));
  const map = MAPS.has(m.map) ? m.map : 'original';

  removeFromQueues(ws);
  leaveRoom(ws);

  const code = makeRoomCode();
  const id = 'custom-' + code;

  const room = {
    id,
    code,
    custom: true,
    status: 'lobby',
    mode,
    map,
    maxPlayers,
    ownerId: ws.playerId,
    players: [{
      id: ws.playerId,
      name: ws.name || 'Player',
      ws,
      team: null
    }],
    rematch: new Set(),
    truckId: null,
    over: false
  };

  ws.roomId = id;
  rooms.set(id, room);

  const payload = {
    roomCode: code,
    hostId: room.ownerId,
    you: ws.playerId,
    mode,
    map,
    maxPlayers,
    roster: rosterFor(room),
    seed: randomSeed()
  };

  send(ws, { type: 'customLobbyCreated', ...payload });
  broadcastCustomRoomList();
}

function customRoomJoin(ws, m) {
  if (isBanned(ws.name)) return;

  const code = String(m.code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);

  const room = [...rooms.values()].find(r => r.custom && r.code === code);

  if (!room || room.status !== 'lobby') {
    return send(ws, {
      type: 'customRoomError',
      message: 'That room code is invalid or the match has already started.'
    });
  }

  if (room.players.length >= room.maxPlayers) {
    return send(ws, {
      type: 'customRoomError',
      message: 'That custom room is full.'
    });
  }

  if (room.players.some(p => p.id === ws.playerId)) return;

  removeFromQueues(ws);
  leaveRoom(ws);

  room.players.push({
    id: ws.playerId,
    name: ws.name || 'Player',
    ws,
    team: null
  });

  ws.roomId = room.id;
  const roster = rosterFor(room);

  send(ws, {
    type: 'customLobbyJoined',
    roomCode: room.code,
    hostId: room.ownerId,
    you: ws.playerId,
    mode: room.mode,
    map: room.map,
    maxPlayers: room.maxPlayers,
    roster,
    seed: randomSeed()
  });

  for (const other of room.players) {
    if (other.id !== ws.playerId && other.skin) {
      send(ws, { type: 'skin', id: other.id, ...other.skin });
    }
  }

  notifyCustomRoom(room);
  broadcastCustomRoomList();
}

function customRoomStart(ws) {
  const room = roomOf(ws);
  if (!room || !room.custom || room.status !== 'lobby') return;

  if (ws.playerId !== room.ownerId) {
    return send(ws, {
      type: 'customRoomError',
      message: 'Only the room owner can start the match.'
    });
  }

  room.status = 'countdown';
  for (const p of room.players) {
    send(p.ws, { type: 'customCountdown', seconds: 5 });
  }

  broadcastCustomRoomList();
  const roomId = room.id;

  setTimeout(() => {
    const live = rooms.get(roomId);
    if (!live || !live.custom || live.status !== 'countdown') return;

    live.status = 'playing';
    const roster = rosterFor(live);
    const seed = randomSeed();

    for (const p of live.players) {
      send(p.ws, {
        type: 'customStarted',
        roomId: live.id,
        roomCode: live.code,
        hostId: live.ownerId,
        you: p.id,
        mode: live.mode,
        map: live.map,
        maxPlayers: live.maxPlayers,
        roster,
        seed
      });
    }
  }, 5000);
}

function requestRematch(ws) {
  const room = roomOf(ws);
  if (!room) return;

  room.rematch.add(ws.playerId);
  const humans = room.players.filter(p => !p.bot);
  const ready = humans.filter(p => room.rematch.has(p.id)).length;

  broadcast(room, { type: 'rematchVotes', ready, total: humans.length });

  if (humans.length > 0 && ready === humans.length) {
    room.rematch.clear();
    room.over = false;
    broadcast(room, {
      type: 'rematchStart',
      seed: randomSeed(),
      roster: rosterFor(room)
    });
  }
}

const isBotInRoom = (room, id) =>
  room && room.players.some(p => p.id === id && p.bot);

const handlers = {
  setName(ws, m) {
    const clean = String(m.name || 'Player').trim().slice(0, MAX_NAME) || 'Player';

    if (isBanned(clean)) {
      try { ws.close(); } catch (_) {}
      return;
    }

    ws.name = clean;
    broadcastStateToObservers();
  },

  getPlayers(ws) {
    ws.isObserver = true;
    send(ws, {
      type: 'tukdevState',
      players: getOnlinePlayers(),
      banned: [...bannedNames.values()]
    });
    broadcastStateToObservers();
  },

  banUser(ws, m) {
    if (!ADMIN_KEY || String(m.key || '') !== ADMIN_KEY) {
      send(ws, { type: 'adminError', message: 'Invalid admin code.' });
      return;
    }

    const clean = String(m.name || '').trim().slice(0, MAX_NAME);
    if (!clean) return;

    bannedNames.set(clean.toLowerCase(), clean);
    saveBans();
    kickBannedClients();
    broadcastStateToObservers();
  },

  unbanUser(ws, m) {
    if (!ADMIN_KEY || String(m.key || '') !== ADMIN_KEY) {
      send(ws, { type: 'adminError', message: 'Invalid admin code.' });
      return;
    }

    const key = normalizeName(m.name);
    if (!key) return;

    bannedNames.delete(key);
    saveBans();
    broadcastStateToObservers();
  },

  queue(ws, m) { joinQueue(ws, m.mode, m.map); },
  customCreate(ws, m) { customRoomCreate(ws, m); },
  customJoin(ws, m) { customRoomJoin(ws, m); },
  customList(ws) { send(ws, { type: 'customRooms', rooms: customRoomList() }); },
  customStart(ws) { customRoomStart(ws); },

  leaveQueue(ws) {
    removeFromQueues(ws);
    send(ws, { type: 'queueLeft' });
  },

  leaveRoom(ws) {
    leaveRoom(ws);
    send(ws, { type: 'roomLeft' });
  },

  rematch(ws) { requestRematch(ws); },

  skin(ws, m) {
    const room = roomOf(ws);
    if (!room) return;

    const color = Number.isInteger(m.color)
      ? (m.color >>> 0) & 0xffffff
      : 0x2ecc71;

    let image = null;
    if (
      typeof m.image === 'string' &&
      /^data:image\/(?:jpeg|png|webp);base64,/i.test(m.image) &&
      m.image.length <= 360000
    ) {
      image = m.image;
    }

    ws.skin = { color, image };
    const player = room.players.find(p => p.id === ws.playerId);
    if (player) player.skin = ws.skin;

    broadcast(room, {
      type: 'skin',
      id: ws.playerId,
      color,
      image
    }, ws.playerId);
  },

  state(ws, m) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'state',
      id: ws.playerId,
      x: m.x,
      y: m.y,
      z: m.z,
      heading: m.heading,
      health: m.health,
      alive: m.alive,
      boosting: m.boosting,
      gunAim: m.gunAim
    }, ws.playerId);
  },

  fire(ws, m) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'fire',
      id: ws.playerId,
      origin: m.origin,
      dir: m.dir
    }, ws.playerId);
  },

  botState(ws, m) {
    const room = roomOf(ws);
    if (!isBotInRoom(room, m.id)) return;

    broadcast(room, {
      type: 'state',
      id: m.id,
      x: m.x,
      y: m.y,
      z: m.z,
      heading: m.heading,
      health: m.health,
      alive: m.alive,
      boosting: m.boosting,
      gunAim: m.gunAim
    }, ws.playerId);
  },

  botFire(ws, m) {
    const room = roomOf(ws);
    if (!isBotInRoom(room, m.id)) return;

    broadcast(room, {
      type: 'fire',
      id: m.id,
      origin: m.origin,
      dir: m.dir
    }, ws.playerId);
  },

  hit(ws, m) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'hit',
      shooter: m.by || ws.playerId,
      target: m.target,
      damage: m.damage,
      trample: !!m.trample
    });
  },

  barrel(ws, m) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'barrel',
      id: m.id,
      by: m.by
    }, ws.playerId);
  }
};

wss.on('error', err => console.error('WebSocket error:', err.message));

wss.on('connection', ws => {
  ws.playerId = 'p' + Math.random().toString(36).slice(2, 8);
  ws.name = 'Player';
  ws.roomId = null;
  ws.isObserver = false;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', err => console.error('Socket error:', err.message));

  console.log('Connected: ' + ws.playerId + ' (' + wss.clients.size + ' online)');
  send(ws, { type: 'hello', id: ws.playerId });
  broadcastStateToObservers();

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const handler = handlers[msg.type];
    if (!handler) return;

    try {
      handler(ws, msg);
    } catch (err) {
      console.error('Message error (' + msg.type + '):', err.stack);
    }
  });

  ws.on('close', () => {
    console.log('Disconnected: ' + ws.playerId);
    removeFromQueues(ws);
    leaveRoom(ws);
    broadcastStateToObservers();
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Tuk Tuk Madness server listening on port ${PORT}`);
});

process.on('uncaughtException', err =>
  console.error('Uncaught error:', err.stack)
);
process.on('unhandledRejection', err =>
  console.error('Unhandled rejection:', err)
);
