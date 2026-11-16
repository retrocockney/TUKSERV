<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tukdev — Online Player Manager</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px;
    background: #0b0f1e;
    color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .container {
    max-width: 620px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid #23335a;
  }
  h1 {
    margin: 0;
    font-size: 24px;
    letter-spacing: 1px;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
  }
  input {
    background: #141d36;
    color: #fff;
    border: 1px solid #2f4a8a;
    border-radius: 8px;
    padding: 9px 12px;
    font-size: 14px;
  }
  input#serverInput { flex: 1 1 240px; }
  input#adminCodeInput { flex: 0 1 160px; }
  button {
    background: #2f4a8a;
    color: #fff;
    border: 1px solid #2f4a8a;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s, background 0.15s;
  }
  button:hover:not(:disabled) { background: #3d5fb0; }
  button.ban-btn {
    background: #c0392b;
    border-color: #c0392b;
  }
  button.ban-btn:hover:not(:disabled) { background: #e74c3c; }
  button.unban-btn {
    background: #27ae60;
    border-color: #27ae60;
  }
  button.unban-btn:hover:not(:disabled) { background: #2ecc71; }
  button:disabled {
    background: #1b243d;
    border-color: #263354;
    color: #5d6c8f;
    cursor: not-allowed;
    opacity: 0.55;
  }
  .status-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: #b7c6e6;
    background: #11182d;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid #1e2d52;
    margin-bottom: 16px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #e74c3c;
    flex-shrink: 0;
  }
  .dot.connected { background: #2ecc71; }
  .dot.connecting { background: #f1c40f; }
  .error-banner {
    background: rgba(231, 76, 60, 0.2);
    border: 1px solid #e74c3c;
    color: #ff9c92;
    padding: 9px 14px;
    border-radius: 8px;
    font-size: 13px;
    margin-bottom: 14px;
    display: none;
  }
  .card {
    background: #11182d;
    border: 1px solid #23335a;
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 18px;
  }
  .card-header {
    background: #182342;
    padding: 11px 16px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: #9fb3df;
    display: flex;
    justify-content: space-between;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    padding: 11px 16px;
    border-bottom: 1px solid #1c294a;
    font-size: 15px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  li:last-child { border-bottom: none; }
  .name-label {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .empty {
    padding: 28px 16px;
    text-align: center;
    color: #8fa3cf;
    font-size: 14px;
    justify-content: center;
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>TUKDEV</h1>
  </header>

  <div class="controls">
    <input id="serverInput" type="text" value="wss://tukserv.onrender.com" title="WebSocket Server URL">
    <input id="adminCodeInput" type="password" placeholder="Admin code" title="Enter admin code to ban/unban">
    <button id="btnRefresh">Refresh</button>
  </div>

  <div id="errorBanner" class="error-banner"></div>

  <div class="status-bar">
    <span id="statusDot" class="dot"></span>
    <span id="statusText">Connecting to server...</span>
  </div>

  <div class="card">
    <div class="card-header">
      <span>Online Players (A–Z)</span>
      <span id="onlineCount">0 online</span>
    </div>
    <ul id="onlineList">
      <li class="empty">Connecting...</li>
    </ul>
  </div>

  <div class="card">
    <div class="card-header">
      <span>Banned Usernames (A–Z)</span>
      <span id="bannedCount">0 banned</span>
    </div>
    <ul id="bannedList">
      <li class="empty">No banned usernames.</li>
    </ul>
  </div>
</div>

<script>
(function () {
  const serverInput = document.getElementById('serverInput');
  const adminCodeInput = document.getElementById('adminCodeInput');
  const btnRefresh = document.getElementById('btnRefresh');
  const errorBanner = document.getElementById('errorBanner');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const onlineCount = document.getElementById('onlineCount');
  const onlineList = document.getElementById('onlineList');
  const bannedCount = document.getElementById('bannedCount');
  const bannedList = document.getElementById('bannedList');

  let ws = null;
  let onlinePlayers = [];
  let bannedUsernames = [];

  function setStatus(text, state) {
    statusText.textContent = text;
    statusDot.className = 'dot' + (state ? ' ' + state : '');
  }

  function showError(msg) {
    if (!msg) {
      errorBanner.style.display = 'none';
      errorBanner.textContent = '';
      return;
    }
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
  }

  function getAdminCode() {
    const typed = adminCodeInput.value.trim();
    if (typed) return typed;
    const prompted = window.prompt('Enter admin code to continue:');
    if (prompted !== null) {
      adminCodeInput.value = prompted.trim();
      return adminCodeInput.value;
    }
    return '';
  }

  function sendCommand(type, name) {
    showError('');
    const key = getAdminCode();
    if (!key) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showError('Not connected to server.');
      return;
    }
    ws.send(JSON.stringify({ type, name, key }));
  }

  function createRow(name, isBanned) {
    const li = document.createElement('li');

    const span = document.createElement('span');
    span.className = 'name-label';
    span.textContent = name;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const banBtn = document.createElement('button');
    banBtn.className = 'ban-btn';
    banBtn.textContent = 'Ban';
    banBtn.disabled = isBanned;
    if (!isBanned) {
      banBtn.addEventListener('click', () => sendCommand('banUser', name));
    }

    const unbanBtn = document.createElement('button');
    unbanBtn.className = 'unban-btn';
    unbanBtn.textContent = 'Unban';
    unbanBtn.disabled = !isBanned;
    if (isBanned) {
      unbanBtn.addEventListener('click', () => sendCommand('unbanUser', name));
    }

    actions.appendChild(banBtn);
    actions.appendChild(unbanBtn);
    li.appendChild(span);
    li.appendChild(actions);
    return li;
  }

  function render() {
    const bannedSet = new Set(bannedUsernames.map(n => n.toLowerCase()));

    const sortedOnline = onlinePlayers
      .map(p => String(p.name || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    onlineCount.textContent = sortedOnline.length + ' online';
    onlineList.innerHTML = '';
    if (sortedOnline.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No players currently online.';
      onlineList.appendChild(empty);
    } else {
      sortedOnline.forEach(name => {
        onlineList.appendChild(createRow(name, bannedSet.has(name.toLowerCase())));
      });
    }

    const sortedBanned = bannedUsernames
      .map(n => String(n || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    bannedCount.textContent = sortedBanned.length + ' banned';
    bannedList.innerHTML = '';
    if (sortedBanned.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No banned usernames.';
      bannedList.appendChild(empty);
    } else {
      sortedBanned.forEach(name => {
        bannedList.appendChild(createRow(name, true));
      });
    }
  }

  function connect() {
    if (ws) {
      ws.close();
      ws = null;
    }
    showError('');
    onlinePlayers = [];
    bannedUsernames = [];
    render();

    const url = serverInput.value.trim();
    if (!url) return;

    setStatus('Connecting to ' + url + '...', 'connecting');
    ws = new WebSocket(url);

    ws.onopen = () => {
      setStatus('Connected', 'connected');
      ws.send(JSON.stringify({ type: 'getPlayers' }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'tukdevState') {
        onlinePlayers = Array.isArray(msg.players) ? msg.players : [];
        bannedUsernames = Array.isArray(msg.banned) ? msg.banned : [];
        render();
      } else if (msg.type === 'adminError') {
        showError(msg.message || 'Action rejected by server.');
      }
    };

    ws.onerror = () => {
      setStatus('Could not connect to server.');
    };

    ws.onclose = () => {
      ws = null;
      setStatus('Disconnected from server.');
    };
  }

  btnRefresh.addEventListener('click', connect);
  connect();
})();
</script>
</body>
</html>
