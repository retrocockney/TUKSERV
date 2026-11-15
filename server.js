// Tuk Tuk Madness: matchmaking and relay server (friends-only version)
// Players connect over WebSocket, join a queue for "1v1" or "2v2", and get matched into rooms.
// Each player's browser sends its own tuk-tuk state and actions; the server relays them to the room.
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MODES = { '1v1': 2, '2v2': 4, 'truck': 4 };
const BOT_WAIT_MS = 15000; // how long a queued player waits before bots fill the match
const MAX_NAME = 30;

const wss = new WebSocketServer({ port: PORT });
const queues = { '1v1': [], '2v2': [] };
const rooms = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function roomOf(ws) {
  return ws.roomId ? rooms.get(ws.roomId) : null;
}

function broadcast(room, msg, exceptId = null) {
  for (const p of room.players) {
    if (p.id !== exceptId) send(p.ws, msg);
  }
}

const botTimers = {};
let nextBotId = 1;
let nextBotName = 1;

function clearBotTimer(mode) {
  if (botTimers[mode]) { clearTimeout(botTimers[mode]); botTimers[mode] = null; }
}

// Starts the bot countdown once a real player is waiting in a queue
function startBotTimer(mode) {
  if (botTimers[mode] || !queues[mode].some(e => !e.bot)) return;
  botTimers[mode] = setTimeout(() => { botTimers[mode] = null; fillWithBots(mode); }, BOT_WAIT_MS);
}

function fillWithBots(mode) {
  const q = queues[mode];
  if (!q.some(e => !e.bot)) return;
  while (q.length < MODES[mode]) q.push({ bot: true, name: 'BOT ' + nextBotName++ });
  tryStartMatch(mode);
}

function removeFromQueue(ws) {
  for (const mode of Object.keys(queues)) {
    queues[mode] = queues[mode].filter(p => p.ws !== ws);
    if (!queues[mode].some(e => !e.bot)) clearBotTimer(mode);
  }
}

// Bots fill a 2v2 or Monster Truck queue once every waiting player is holding E
function checkFill(mode) {
  const humans = queues[mode].filter(e => !e.bot);
  if (humans.length === 0) return;
  const holding = humans.filter(e => e.ws.holdingE).length;
  for (const e of humans) send(e.ws, { type: 'fillStatus', holding, total: humans.length });
  if (holding === humans.length) fillWithBots(mode);
}

// Builds the roster for a match: teams in 2v2, and one random truck in monster truck mode
function rosterFor(room) {
  const truckIdx = room.mode === 'truck' ? Math.floor(Math.random() * room.players.length) : -1;
  return room.players.map((p, idx) => ({
    id: p.id,
    name: p.name,
    bot: !!p.bot,
    team: room.mode === '2v2' ? p.team : (room.mode === 'truck' ? (idx === truckIdx ? 'truck' : 'tuks') : null),
    role: room.mode === 'truck' ? (idx === truckIdx ? 'truck' : 'tuk') : 'player'
  }));
}

function tryStartMatch(mode) {
  const need = MODES[mode];
  const q = queues[mode];
  if (q.length < need) return;

  const picked = q.splice(0, need);
  if (!q.some(e => !e.bot)) clearBotTimer(mode);
  const roomId = 'room' + nextId++;
  const room = { id: roomId, mode, players: [] };

  picked.forEach((entry, idx) => {
    const team = mode === '2v2' ? (idx < 2 ? 'blue' : 'orange') : null;
    if (entry.bot) {
      room.players.push({ id: 'bot-' + nextBotId++, name: entry.name, team, ws: null, bot: true });
    } else {
      room.players.push({ id: entry.ws.playerId, name: entry.name, team, ws: entry.ws });
      entry.ws.roomId = roomId;
    }
  });
  rooms.set(roomId, room);

  const roster = rosterFor(room);
  const seed = Math.floor(Math.random() * 1e9);
  for (const p of room.players) {
    send(p.ws, { type: 'matchFound', roomId, mode, you: p.id, team: p.team, roster, seed });
  }
}

function leaveRoom(ws) {
  const room = roomOf(ws);
  if (!room) return;
  room.players = room.players.filter(p => p.ws !== ws);
  broadcast(room, { type: 'playerLeft', id: ws.playerId });
  if (!room.players.some(p => !p.bot)) rooms.delete(room.id);
  ws.roomId = null;
}

wss.on('error', err => console.error('Server error:', err && err.message));

wss.on('connection', ws => {
  ws.on('error', err => console.error('Socket error:', err && err.message));
  ws.playerId = 'p' + Math.random().toString(36).slice(2, 8);
  console.log('Connected: ' + ws.playerId + ' (' + wss.clients.size + ' online)');
  ws.name = 'Player';
  send(ws, { type: 'hello', id: ws.playerId });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'setName':
        ws.name = String(msg.name || 'Player').trim().slice(0, MAX_NAME) || 'Player';
        break;

      case 'queue':
        if (!MODES[msg.mode] || roomOf(ws)) return;
        removeFromQueue(ws);
        queues[msg.mode].push({ ws, name: ws.name });
        send(ws, { type: 'queued', mode: msg.mode, waiting: queues[msg.mode].length });
        tryStartMatch(msg.mode);
        break;

      case 'leaveQueue':
        removeFromQueue(ws);
        send(ws, { type: 'queueLeft' });
        break;

      case 'state': {
        // Position and status of this player's tuk-tuk, relayed to the room
        const room = roomOf(ws);
        if (!room) return;
        broadcast(room, { type: 'state', id: ws.playerId, x: msg.x, y: msg.y, z: msg.z,
          heading: msg.heading, health: msg.health, alive: msg.alive, boosting: msg.boosting,
          gunAim: msg.gunAim }, ws.playerId);
        break;
      }

      case 'fire': {
        // A rocket fired by this player, so others can draw it
        const room = roomOf(ws);
        if (!room) return;
        broadcast(room, { type: 'fire', id: ws.playerId, origin: msg.origin, dir: msg.dir }, ws.playerId);
        break;
      }

      case 'hit': {
        // This player reports that one of their rockets hit someone (trusted for friends-only play)
        const room = roomOf(ws);
        if (!room) return;
        broadcast(room, { type: 'hit', shooter: msg.by || ws.playerId, target: msg.target, damage: msg.damage, trample: !!msg.trample });
        break;
      }

      case 'fillKey': {
        ws.holdingE = !!msg.down;
        for (const mode of ['2v2', 'truck']) {
          if (queues[mode].some(e => e.ws === ws)) checkFill(mode);
        }
        break;
      }

      case 'botState': {
        // The host reports a bot's position; only bots in this room are accepted
        const room = roomOf(ws);
        if (!room || !room.players.some(p => p.id === msg.id && p.bot)) return;
        broadcast(room, { type: 'state', id: msg.id, x: msg.x, y: msg.y, z: msg.z, heading: msg.heading,
          health: msg.health, alive: msg.alive, boosting: msg.boosting, gunAim: msg.gunAim }, ws.playerId);
        break;
      }

      case 'botFire': {
        const room = roomOf(ws);
        if (!room || !room.players.some(p => p.id === msg.id && p.bot)) return;
        broadcast(room, { type: 'fire', id: msg.id, origin: msg.origin, dir: msg.dir }, ws.playerId);
        break;
      }

      case 'barrel': {
        // A barrel blew up on this player's screen; everyone else blows it up too
        const room = roomOf(ws);
        if (!room) return;
        broadcast(room, { type: 'barrel', id: msg.id, by: msg.by }, ws.playerId);
        break;
      }

      case 'rematch': {
        // Everyone in the room has to ask for a rematch before a new match starts
        const room = roomOf(ws);
        if (!room) return;
        if (!room.rematch) room.rematch = new Set();
        room.rematch.add(ws.playerId);
        const humans = room.players.filter(p => !p.bot);
        const ready = humans.filter(p => room.rematch.has(p.id)).length;
        broadcast(room, { type: 'rematchVotes', ready, total: humans.length });
        if (humans.length > 0 && ready >= humans.length) {
          room.rematch.clear();
          const roster = rosterFor(room);
          broadcast(room, { type: 'rematchStart', seed: Math.floor(Math.random() * 1e9), roster });
        }
        break;
      }

      case 'leaveRoom':
        leaveRoom(ws);
        send(ws, { type: 'roomLeft' });
        break;
    }
  });

  ws.on('close', () => {
    console.log('Disconnected: ' + ws.playerId);
    removeFromQueue(ws);
    leaveRoom(ws);
  });
});

console.log(`Tuk Tuk Madness server listening on port ${PORT}`);
