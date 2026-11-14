// Tuk Tuk Madness: matchmaking and relay server (friends-only version)
// Players connect over WebSocket, join a queue for "1v1" or "2v2", and get matched into rooms.
// Each player's browser sends its own tuk-tuk state and actions; the server relays them to the room.
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MODES = { '1v1': 2, '2v2': 4 };
const MAX_NAME = 30;

const wss = new WebSocketServer({ port: PORT });
const queues = { '1v1': [], '2v2': [] };
const rooms = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function roomOf(ws) {
  return ws.roomId ? rooms.get(ws.roomId) : null;
}

function broadcast(room, msg, exceptId = null) {
  for (const p of room.players) {
    if (p.id !== exceptId) send(p.ws, msg);
  }
}

function removeFromQueue(ws) {
  for (const mode of Object.keys(queues)) {
    queues[mode] = queues[mode].filter(p => p.ws !== ws);
  }
}

function tryStartMatch(mode) {
  const need = MODES[mode];
  const q = queues[mode];
  if (q.length < need) return;

  const picked = q.splice(0, need);
  const roomId = 'room' + nextId++;
  const room = { id: roomId, mode, players: [] };

  picked.forEach((entry, idx) => {
    const team = mode === '2v2' ? (idx < 2 ? 'blue' : 'orange') : null;
    const player = { id: entry.ws.playerId, name: entry.name, team, ws: entry.ws };
    room.players.push(player);
    entry.ws.roomId = roomId;
  });
  rooms.set(roomId, room);

  const roster = room.players.map(p => ({ id: p.id, name: p.name, team: p.team }));
  for (const p of room.players) {
    send(p.ws, { type: 'matchFound', roomId, mode, you: p.id, team: p.team, roster });
  }
}

function leaveRoom(ws) {
  const room = roomOf(ws);
  if (!room) return;
  room.players = room.players.filter(p => p.ws !== ws);
  broadcast(room, { type: 'playerLeft', id: ws.playerId });
  if (room.players.length === 0) rooms.delete(room.id);
  ws.roomId = null;
}

wss.on('connection', ws => {
  ws.playerId = 'p' + Math.random().toString(36).slice(2, 8);
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
        broadcast(room, { type: 'hit', shooter: ws.playerId, target: msg.target, damage: msg.damage });
        break;
      }

      case 'leaveRoom':
        leaveRoom(ws);
        send(ws, { type: 'roomLeft' });
        break;
    }
  });

  ws.on('close', () => {
    removeFromQueue(ws);
    leaveRoom(ws);
  });
});

console.log(`Tuk Tuk Madness server listening on port ${PORT}`);
