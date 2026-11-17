
// Tuk Tuk Madness: matchmaking and relay server
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'Valley47';
const BAN_FILE = path.join(__dirname, 'bans.json');
const MODES = { '1v1': 2, '2v2': 4, ffa: 4, truck: 4 };
const MAX_NAME = 30;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('Tuk Tuk Madness server running');
});

const wss = new WebSocketServer({ server: httpServer });
const queues = { '1v1': [], '2v2': [], ffa: [], truck: [] };
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
    fs.writeFileSync(
      BAN_FILE,
      JSON.stringify(Array.from(bannedNames.values()), null, 2)
    );
  } catch (err) {
    console.error('Failed to save bans:', err.message);
  }
}

loadBans();

const normalizeName = name => String(name || '').trim().toLowerCase();
const isBanned = name => bannedNames.has(normalizeName(name));
const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
};

const roomOf = ws => ws.roomId ? rooms.get(ws.roomId) : undefined;
const randomSeed = () => Math.floor(Math.random() * 1e9);

function getOnlinePlayers() {
  const list = [];
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN && !client.isObserver) {
      list.push({
        id: client.playerId,
        name: client.name || 'Player'
      });
    }
  }
  return list;
}

function broadcastStateToObservers() {
  const payload = {
    type: 'tukdevState',
    players: getOnlinePlayers(),
    banned: Array.from(bannedNames.values())
  };

  for (const client of wss.clients) {
    if (client.isObserver) send(client, payload);
  }
}

function broadcast(room, msg, exceptId) {
  for (const p of room.players) {
    if (p.ws && p.id !== exceptId) send(p.ws, msg);
  }
}

function removeFromQueues(ws) {
  for (const mode of Object.keys(queues)) {
    queues[mode] = queues[mode].filter(e => e.ws !== ws);
  }
}

function rosterFor(room) {
  const truckIdx = room.mode === 'truck'
    ? Math.floor(Math.random() * room.players.length)
    : -1;

  const roster = room.players.map((p, idx) => {
    let team = null;
    let role = 'player';

    if (room.mode === '2v2') team = p.team;

    if (room.mode === 'truck') {
      const isTruck = idx === truckIdx;
      team = isTruck ? 'truck' : 'tuks';
      role = isTruck ? 'truck' : 'tuk';
    }

    return {
      id: p.id,
      name: p.name,
      bot: !!p.bot,
      team,
      role
    };
  });

  if (room.mode === 'truck') {
    const t = roster.find(r => r.role === 'truck');
    room.truckId = t ? t.id : null;
  }

  return roster;
}

function createRoom(mode, entries) {
  const id = 'room' + roomSeq++;

  const room = {
    id,
    mode,
    players: [],
    rematch: new Set(),
    truckId: null,
    over: false
  };

  entries.forEach((entry, idx) => {
    const team = mode === '2v2'
      ? (idx < 2 ? 'blue' : 'orange')
      : null;

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
      you: p.id,
      team: p.team,
      roster,
      seed
    });
  }
}

function endRound(room, winner, reason) {
  if (room.over) return;
  room.over = true;
  broadcast(room, { type: 'roundEnd', winner, reason });
}

function leaveRoom(ws) {
  const room = roomOf(ws);
  if (!room) return;

  const wasTruck = room.mode === 'truck' &&
    room.truckId === ws.playerId;

  room.players = room.players.filter(p => p.ws !== ws);
  room.rematch.delete(ws.playerId);
  ws.roomId = null;

  broadcast(room, {
    type: 'playerLeft',
    id: ws.playerId
  });

  if (room.mode === 'truck' && !room.over) {
    if (wasTruck) {
      endRound(room, 'tuks', 'The truck left the match');
    } else if (!room.players.some(p => p.id !== room.truckId)) {
      endRound(room, 'truck', 'All the tuks left the match');
    }
  }

  if (!room.players.some(p => !p.bot)) {
    rooms.delete(room.id);
  }
}

function tryStart(mode) {
  const need = MODES[mode];
  const q = queues[mode];

  if (q.length < need) return;
  createRoom(mode, q.splice(0, need));
}

function joinQueue(ws, mode) {
  if (isBanned(ws.name)) {
    try { ws.close(); } catch (_) {}
    return;
  }

  if (!MODES[mode]) return;

  if (roomOf(ws)) leaveRoom(ws);
  removeFromQueues(ws);

  queues[mode].push({
    ws,
    name: ws.name
  });

  send(ws, {
    type: 'queued',
    mode,
    waiting: queues[mode].length
  });

  tryStart(mode);
}

function requestRematch(ws) {
  const room = roomOf(ws);
  if (!room) return;

  room.rematch.add(ws.playerId);

  const humans = room.players.filter(p => !p.bot);
  const ready = humans.filter(p => room.rematch.has(p.id)).length;

  broadcast(room, {
    type: 'rematchVotes',
    ready,
    total: humans.length
  });

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
    const clean = String(m.name || 'Player')
      .trim()
      .slice(0, MAX_NAME) || 'Player';

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
      banned: Array.from(bannedNames.values())
    });

    broadcastStateToObservers();
  },

  banUser(ws, m) {
    if (String(m.key || '') !== ADMIN_KEY) {
      send(ws, {
        type: 'adminError',
        message: 'Invalid admin code.'
      });
      return;
    }

    const clean = String(m.name || '').trim().slice(0, MAX_NAME);
    if (!clean) return;

    bannedNames.set(clean.toLowerCase(), clean);
    saveBans();
    broadcastStateToObservers();
  },

  unbanUser(ws, m) {
    if (String(m.key || '') !== ADMIN_KEY) {
      send(ws, {
        type: 'adminError',
        message: 'Invalid admin code.'
      });
      return;
    }

    const key = normalizeName(m.name);
    if (!key) return;

    bannedNames.delete(key);
    saveBans();
    broadcastStateToObservers();
  },

  queue(ws, m) {
    joinQueue(ws, m.mode);
  },

  leaveQueue(ws) {
    removeFromQueues(ws);
    send(ws, { type: 'queueLeft' });
  },

  leaveRoom(ws) {
    leaveRoom(ws);
    send(ws, { type: 'roomLeft' });
  },

  rematch(ws) {
    requestRematch(ws);
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

wss.on('error', err =>
  console.error('WebSocket error:', err.message)
);

wss.on('connection', ws => {
  ws.playerId = 'p' + Math.random().toString(36).slice(2, 8);
  ws.name = 'Player';
  ws.roomId = null;
  ws.isObserver = false;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('error', err =>
    console.error('Socket error:', err.message)
  );

  console.log(
    'Connected: ' + ws.playerId +
    ' (' + wss.clients.size + ' online)'
  );

  send(ws, {
    type: 'hello',
    id: ws.playerId
  });

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
      console.error(
        'Message error (' + msg.type + '):',
        err.stack
      );
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

    try {
      ws.ping();
    } catch (_) {}
  }
}, 25000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Tuk Tuk Madness server listening on port ${PORT}`
  );
});

process.on('uncaughtException', err =>
  console.error('Uncaught error:', err.stack)
);

process.on('unhandledRejection', err =>
  console.error('Unhandled rejection:', err)
);
