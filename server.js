
// TUK TUK MADNESS - MULTIPLAYER SERVER
// No bot filling. Matches require real players.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'Valley47';
const BAN_FILE = path.join(__dirname, 'bans.json');

const MODES = {
  '1v1': 2,
  '2v2': 4,
  truck: 4
};

const MAX_NAME = 30;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('Tuk Tuk Madness server running');
});

const wss = new WebSocketServer({ server: httpServer });

const queues = {
  '1v1': [],
  '2v2': [],
  truck: []
};

const rooms = new Map();
let roomSeq = 1;

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

const normalizeName = name =>
  String(name || '').trim().toLowerCase();

const isBanned = name =>
  bannedNames.has(normalizeName(name));

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function roomOf(ws) {
  return ws.roomId ? rooms.get(ws.roomId) : undefined;
}

function randomSeed() {
  return Math.floor(Math.random() * 1e9);
}

function getOnlinePlayers() {
  const players = [];

  for (const client of wss.clients) {
    if (client.readyState === client.OPEN && !client.isObserver) {
      players.push({
        id: client.playerId,
        name: client.name || 'Player'
      });
    }
  }

  return players;
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

function removeFromQueues(ws) {
  for (const mode of Object.keys(queues)) {
    queues[mode] = queues[mode].filter(entry => entry.ws !== ws);
  }
}

function kickBannedClients() {
  for (const client of wss.clients) {
    if (!client.isObserver && isBanned(client.name)) {
      removeFromQueues(client);
      leaveRoom(client);
      try {
        client.close();
      } catch (_) {}
    }
  }
}

function broadcast(room, message, exceptId) {
  for (const player of room.players) {
    if (player.ws && player.id !== exceptId) {
      send(player.ws, message);
    }
  }
}

function rosterFor(room) {
  let truckIndex = -1;

  if (room.mode === 'truck') {
    truckIndex = Math.floor(Math.random() * room.players.length);
  }

  const roster = room.players.map((player, index) => {
    let team = null;
    let role = 'player';

    if (room.mode === '2v2') {
      team = player.team;
    }

    if (room.mode === 'truck') {
      const isTruck = index === truckIndex;
      team = isTruck ? 'truck' : 'tuks';
      role = isTruck ? 'truck' : 'tuk';
    }

    return {
      id: player.id,
      name: player.name,
      team,
      role
    };
  });

  if (room.mode === 'truck') {
    const truck = roster.find(player => player.role === 'truck');
    room.truckId = truck ? truck.id : null;
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

  entries.forEach((entry, index) => {
    const team =
      mode === '2v2'
        ? (index < 2 ? 'blue' : 'orange')
        : null;

    room.players.push({
      id: entry.ws.playerId,
      name: entry.name,
      team,
      ws: entry.ws
    });

    entry.ws.roomId = id;
  });

  rooms.set(id, room);

  const roster = rosterFor(room);
  const seed = randomSeed();

  for (const player of room.players) {
    send(player.ws, {
      type: 'matchFound',
      roomId: id,
      mode,
      you: player.id,
      team: player.team,
      roster,
      seed
    });
  }

  console.log(`Started ${mode} match: ${id}`);
}

function endRound(room, winner, reason) {
  if (room.over) return;

  room.over = true;

  broadcast(room, {
    type: 'roundEnd',
    winner,
    reason
  });
}

function leaveRoom(ws) {
  const room = roomOf(ws);
  if (!room) return;

  const wasTruck =
    room.mode === 'truck' &&
    room.truckId === ws.playerId;

  room.players = room.players.filter(
    player => player.ws !== ws
  );

  room.rematch.delete(ws.playerId);
  ws.roomId = null;

  broadcast(room, {
    type: 'playerLeft',
    id: ws.playerId
  });

  if (room.mode === 'truck' && !room.over) {
    if (wasTruck) {
      endRound(room, 'tuks', 'The truck left the match');
    } else if (
      !room.players.some(player => player.id !== room.truckId)
    ) {
      endRound(room, 'truck', 'All the tuks left the match');
    }
  }

  if (room.players.length === 0) {
    rooms.delete(room.id);
  }
}

// MATCHMAKING - REAL PLAYERS ONLY

function tryStart(mode) {
  const requiredPlayers = MODES[mode];
  const queue = queues[mode];

  if (queue.length < requiredPlayers) return;

  const entries = queue.splice(0, requiredPlayers);
  createRoom(mode, entries);
}

function joinQueue(ws, mode) {
  if (isBanned(ws.name)) {
    try {
      ws.close();
    } catch (_) {}
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
    send(ws, {
      type: 'queueError',
      message: 'Unknown game mode.'
    });
    return;
  }

  if (roomOf(ws)) {
    leaveRoom(ws);
  }

  removeFromQueues(ws);

  queues[mode].push({
    ws,
    name: ws.name
  });

  send(ws, {
    type: 'queued',
    mode,
    waiting: queues[mode].length,
    required: MODES[mode]
  });

  tryStart(mode);
}

// REMATCH

function requestRematch(ws) {
  const room = roomOf(ws);
  if (!room) return;

  room.rematch.add(ws.playerId);

  const humans = room.players;
  const ready = humans.filter(
    player => room.rematch.has(player.id)
  ).length;

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

// MESSAGE HANDLERS

const handlers = {
  setName(ws, message) {
    const clean =
      String(message.name || 'Player')
        .trim()
        .slice(0, MAX_NAME) || 'Player';

    if (isBanned(clean)) {
      ws.close();
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

  banUser(ws, message) {
    if (String(message.key || '') !== ADMIN_KEY) {
      send(ws, {
        type: 'adminError',
        message: 'Invalid admin code.'
      });
      return;
    }

    const clean =
      String(message.name || '').trim().slice(0, MAX_NAME);

    if (!clean) return;

    bannedNames.set(clean.toLowerCase(), clean);
    saveBans();
    kickBannedClients();
    broadcastStateToObservers();
  },

  unbanUser(ws, message) {
    if (String(message.key || '') !== ADMIN_KEY) {
      send(ws, {
        type: 'adminError',
        message: 'Invalid admin code.'
      });
      return;
    }

    bannedNames.delete(normalizeName(message.name));
    saveBans();
    broadcastStateToObservers();
  },

  queue(ws, message) {
    joinQueue(ws, message.mode);
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

  state(ws, message) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'state',
      id: ws.playerId,
      x: message.x,
      y: message.y,
      z: message.z,
      heading: message.heading,
      health: message.health,
      alive: message.alive,
      boosting: message.boosting,
      gunAim: message.gunAim
    }, ws.playerId);
  },

  fire(ws, message) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'fire',
      id: ws.playerId,
      origin: message.origin,
      dir: message.dir
    }, ws.playerId);
  },

  hit(ws, message) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'hit',
      shooter: message.by || ws.playerId,
      target: message.target,
      damage: message.damage,
      trample: !!message.trample
    });
  },

  barrel(ws, message) {
    const room = roomOf(ws);
    if (!room) return;

    broadcast(room, {
      type: 'barrel',
      id: message.id,
      by: message.by
    }, ws.playerId);
  }
};

// CONNECTIONS

wss.on('error', err => {
  console.error('WebSocket error:', err.message);
});

wss.on('connection', ws => {
  ws.playerId = 'p' + Math.random().toString(36).slice(2, 8);
  ws.name = 'Player';
  ws.roomId = null;
  ws.isObserver = false;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('error', err => {
    console.error('Socket error:', err.message);
  });

  console.log(
    'Connected:',
    ws.playerId,
    '(' + wss.clients.size + ' online)'
  );

  send(ws, {
    type: 'hello',
    id: ws.playerId
  });

  broadcastStateToObservers();

  ws.on('message', raw => {
    let message;

    try {
      message = JSON.parse(raw);
    } catch (_) {
      return;
    }

    const handler = handlers[message.type];
    if (!handler) return;

    try {
      handler(ws, message);
    } catch (err) {
      console.error(
        'Message error (' + message.type + '):',
        err.stack
      );
    }
  });

  ws.on('close', () => {
    console.log('Disconnected:', ws.playerId);

    removeFromQueues(ws);
    leaveRoom(ws);
    broadcastStateToObservers();
  });
});

// KEEP CONNECTIONS ALIVE

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

wss.on('close', () => {
  clearInterval(heartbeat);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Tuk Tuk Madness server listening on port ${PORT}`
  );
});

process.on('uncaughtException', err => {
  console.error('Uncaught error:', err.stack);
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});
