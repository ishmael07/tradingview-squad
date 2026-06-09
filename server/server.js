// TradingView Squad — signaling + presence server
// Rooms are joined by a share code. The server relays WebRTC signaling
// (offer/answer/ICE) between peers and broadcasts presence (name + symbol).
// Voice/screen media travels peer-to-peer over WebRTC, never through here.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Plain HTTP server so hosting platforms' health checks pass and you can open the
// URL in a browser to confirm it's live. TLS (wss://) is terminated by the host
// (Render/Railway/Fly) or a tunnel — the Node process itself stays plain ws.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('TradingView Squad signaling server is running.');
});
const wss = new WebSocketServer({ server });

// room code -> Map(clientId -> { ws, name, symbol })
const rooms = new Map();

function send(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

wss.on('connection', (ws) => {
  let myRoom = null;
  let myId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'join') {
      myRoom = String(msg.room || '').trim();
      myId = msg.id;
      if (!myRoom || !myId) return;

      if (!rooms.has(myRoom)) rooms.set(myRoom, new Map());
      const r = rooms.get(myRoom);

      // Snapshot existing peers for the newcomer (they will initiate offers).
      const existing = [...r.entries()].map(([id, c]) => ({
        id, name: c.name, symbol: c.symbol, positions: c.positions, media: c.media,
      }));

      r.set(myId, {
        ws, name: msg.name || 'Anon', symbol: msg.symbol || '', positions: [], media: {},
      });

      send(ws, { type: 'joined', id: myId, peers: existing });

      // Tell everyone else a new peer arrived.
      for (const [id, c] of r) {
        if (id !== myId) {
          send(c.ws, {
            type: 'peer-joined',
            peer: { id: myId, name: msg.name || 'Anon', symbol: msg.symbol || '', positions: [], media: {} },
          });
        }
      }
      console.log(`[${myRoom}] ${msg.name} joined (${r.size} in room)`);

    } else if (msg.type === 'presence') {
      const r = rooms.get(myRoom);
      if (!r) return;
      const c = r.get(myId);
      if (c) { c.symbol = msg.symbol || ''; c.positions = msg.positions || []; c.media = msg.media || {}; }
      for (const [id, cc] of r) {
        if (id !== myId) {
          send(cc.ws, {
            type: 'presence', id: myId, symbol: msg.symbol || '',
            positions: msg.positions || [], media: msg.media || {},
          });
        }
      }

    } else if (msg.type === 'trade') {
      const r = rooms.get(myRoom);
      if (!r) return;
      for (const [id, cc] of r) {
        if (id !== myId) {
          send(cc.ws, {
            type: 'trade', id: myId, event: msg.event,
            symbol: msg.symbol, side: msg.side, qty: msg.qty, avg: msg.avg,
          });
        }
      }

    } else if (msg.type === 'callout') {
      // Manual trade callout — broadcast the whole payload (tagged with sender).
      const r = rooms.get(myRoom);
      if (!r) return;
      for (const [id, cc] of r) {
        if (id !== myId) send(cc.ws, Object.assign({}, msg, { id: myId }));
      }

    } else if (msg.type === 'signal') {
      const r = rooms.get(myRoom);
      if (!r) return;
      const target = r.get(msg.to);
      if (target) send(target.ws, { type: 'signal', from: myId, data: msg.data });
    }
  });

  ws.on('close', () => {
    if (myRoom && rooms.has(myRoom)) {
      const r = rooms.get(myRoom);
      r.delete(myId);
      for (const [, c] of r) send(c.ws, { type: 'peer-left', id: myId });
      if (r.size === 0) rooms.delete(myRoom);
      console.log(`[${myRoom}] ${myId} left (${r.size} remaining)`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`TradingView Squad signaling server listening on :${PORT}`);
});
