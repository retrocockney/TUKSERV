// Tuk Tuk Madness: matchmaking and relay server
// Players queue for 1v1, 2v2 or Monster Truck. When a queue fills, a room is made and everyone is told.
// Browsers send their own tuk-tuk state and actions; the server relays them to the room.
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MODES = { '1v1': 2, '2v2': 4, truck: 4 };
const BOT_FILL_MODES = new Set(['2v2', 'truck']); // queues where everyone holding E can fill with bots
const MAX_NAME = 30;

const wss = new WebSocketServer({ port: PORT });
const queues = { '1v1': [], '2v2': [], truck: [] }; // entries: { ws, name } or { bot: true, name }
const rooms = new Map();
let roomSeq = 1;
let botSeq = 1;
let botNameSeq = 1;

// ---------- Helpers ----------
const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const roomOf = ws => (ws.roomId ? rooms.get(ws.roomId) : undefined);

const humansIn = queue => queue.filter(e => !e.bot);

const randomSeed = () => Math.floor(Math.random() * 1e9);

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

// Builds the roster: teams in 2v2, one random truck in Monster Truck
function rosterFor(room) {
  const truckIdx = room.mode === 'truck' ? Math.floor(Math.random() * room.players.length) : -1;
  return room.players.map((p, idx) => {
    let team = null;
    let role = 'player';
    if (room.mode === '2v2') team = p.team;
    if (room.mode === 'truck') {
      const isTruck = idx === truckIdx;
      team = isTruck ? 'truck' : 'tuks';
      role = isTruck ? 'truck' : 'tuk';
    }
    return { id: p.id, name: p.name, bot: !!p.bot, team, role };
  });
}

// ---------- Rooms ----------
function createRoom(mode, entries) {
  const id = 'room' + roomSeq++;
  const room = { id, mode, players: [], rematch: new Set() };
  entries.forEach((entry, idx) => {
    const team = mode === '2v2' ? (idx < 2 ? 'blue' : 'orange') : null;
    if (entry.bot) {
      room.players.push({ id: 'bot-' + botSeq++, name: entry.name, team, ws: null, bot: true });
    } else {
      room.players.push({ id: entry.ws.playerId, name: entry.name, team, ws: entry.ws });
      entry.ws.roomId = id;
    }
  });
  rooms.set(id, room);

  const roster = rosterFor(room);
  const seed = randomSeed();
  for (const p of room.players) {
    send(p.ws, { type: 'matchFound', roomId: id, mode, you: p.id, team: p.team, roster, seed });
  }
}

function leaveRoom(ws) {
  const room = roomOf(ws);
  if (!room) return;
  room.players = room.players.filter(p => p.ws !== ws);
  room.rematch.delete(ws.playerId);
  ws.roomId = null;
  broadcast(room, { type: 'playerLeft', id: ws.playerId });
  if (!room.players.some(p => !p.bot)) rooms.delete(room.id); // no humans left: close the room
}

// ---------- Queues ----------
function tryStart(mode) {
  const need = MODES[mode];
  const q = queues[mode];
  if (q.length < need) return;
  createRoom(mode, q.splice(0, need));
}

function joinQueue(ws, mode) {
  if (!MODES[mode]) return;
  // A player still attached to an old room (for example after a crash or a missed leave) is moved out first
  if (roomOf(ws)) leaveRoom(ws);
  removeFromQueues(ws);
  ws.holdingE = false;
  queues[mode].push({ ws, name: ws.name });
  send(ws, { type: 'queued', mode, waiting: humansIn(queues[mode]).length });
  tryStart(mode);
}

function setFillKey(ws, down) {
  ws.holdingE = !!down;
  for (const mode of BOT_FILL_MODES) {
    if (queues[mode].some(e => e.ws === ws)) checkFill(mode);
  }
}

// Bots fill the queue once every waiting human is holding E
function checkFill(mode) {
  const humans = humansIn(queues[mode]);
  if (humans.length === 0) return;
  const holding = humans.filter(e => e.ws.holdingE).length;
  for (const e of humans) send(e.ws, { type: 'fillStatus', holding, total: humans.length });
  if (holding === humans.length) {
    const q = queues[mode];
    while (q.length < MODES[mode]) q.push({ bot: true, name: 'BOT ' + botNameSeq++ });
    tryStart(mode);
  }
}

// ---------- Rematch ----------
function requestRematch(ws) {
  const room = roomOf(ws);
  if (!room) return;
  room.rematch.add(ws.playerId);
  const humans = room.players.filter(p => !p.bot);
  const ready = humans.filter(p => room.rematch.has(p.id)).length;
  broadcast(room, { type: 'rematchVotes', ready, total: humans.length });
  if (humans.length > 0 && ready === humans.length) {
    room.rematch.clear();
    broadcast(room, { type: 'rematchStart', seed: randomSeed(), roster: rosterFor(room) });
  }
}

// ---------- Message handlers ----------
const isBotInRoom = (room, id) => room && room.players.some(p => p.id === id && p.bot);

const handlers = {
  setName(ws, m) {
    ws.name = String(m.name || 'Player').trim().slice(0, MAX_NAME) || 'Player';
  },
  queue(ws, m) { joinQueue(ws, m.mode); },
  leaveQueue(ws) {
    removeFromQueues(ws);
    send(ws, { type: 'queueLeft' });
  },
  fillKey(ws, m) { setFillKey(ws, m.down); },
  leaveRoom(ws) {
    leaveRoom(ws);
    send(ws, { type: 'roomLeft' });
  },
  rematch(ws) { requestRematch(ws); },
  state(ws, m) {
    const room = roomOf(ws);
    if (!room) return;
    broadcast(room, {
      type: 'state', id: ws.playerId, x: m.x, y: m.y, z: m.z, heading: m.heading,
      health: m.health, alive: m.alive, boosting: m.boosting, gunAim: m.gunAim
    }, ws.playerId);
  },
  fire(ws, m) {
    const room = roomOf(ws);
    if (!room) return;
    broadcast(room, { type: 'fire', id: ws.playerId, origin: m.origin, dir: m.dir }, ws.playerId);
  },
  // The browser that runs the bots reports their positions and shots
  botState(ws, m) {
    const room = roomOf(ws);
    if (!isBotInRoom(room, m.id)) return;
    broadcast(room, {
      type: 'state', id: m.id, x: m.x, y: m.y, z: m.z, heading: m.heading,
      health: m.health, alive: m.alive, boosting: m.boosting, gunAim: m.gunAim
    }, ws.playerId);
  },
  botFire(ws, m) {
    const room = roomOf(ws);
    if (!isBotInRoom(room, m.id)) return;
    broadcast(room, { type: 'fire', id: m.id, origin: m.origin, dir: m.dir }, ws.playerId);
  },
  hit(ws, m) {
    const room = roomOf(ws);
    if (!room) return;
    broadcast(room, {
      type: 'hit', shooter: m.by || ws.playerId, target: m.target,
      damage: m.damage, trample: !!m.trample
    });
  },
  barrel(ws, m) {
    const room = roomOf(ws);
    if (!room) return;
    broadcast(room, { type: 'barrel', id: m.id, by: m.by }, ws.playerId);
  }
};

// ---------- Connections ----------
wss.on('error', err => console.error('Server error:', err.message));

wss.on('connection', ws => {
  ws.playerId = 'p' + Math.random().toString(36).slice(2, 8);
  ws.name = 'Player';
  ws.roomId = null;
  ws.holdingE = false;
  ws.on('error', err => console.error('Socket error:', err.message));
  console.log('Connected: ' + ws.playerId + ' (' + wss.clients.size + ' online)');
  send(ws, { type: 'hello', id: ws.playerId });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
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
  });
});

console.log(`Tuk Tuk Madness server listening on port ${PORT}`);
process.on('uncaughtException', err => console.error('Uncaught error:', err.stack));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
