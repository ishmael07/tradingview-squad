// Service worker: owns the WebSocket to the signaling server and bridges it
// to the content script. We keep signaling here (not in the content script)
// so it isn't affected by tradingview.com's page CSP, and so host_permissions
// cover the localhost connection. WebRTC media itself lives in the content script.

const SERVER_URL = 'wss://tradingview-squad-signaling.onrender.com';

let ws = null;
let tabId = null;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.to !== 'bg') return;

  if (msg.type === 'open') {
    tabId = sender.tab && sender.tab.id;
    openWs(msg);
  } else if (msg.type === 'ws') {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg.payload)); } catch (_) {}
    }
  } else if (msg.type === 'close') {
    if (ws) { try { ws.close(); } catch (_) {} }
    ws = null;
  }
});

function toCs(m) {
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, Object.assign({ to: 'cs' }, m), () => void chrome.runtime.lastError);
  }
}

function openWs(p) {
  try {
    if (ws) { try { ws.close(); } catch (_) {} }
    ws = new WebSocket(p.url || SERVER_URL);
  } catch (_) {
    toCs({ type: 'status', state: 'error' });
    return;
  }

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({
        type: 'join', room: p.room, name: p.name, id: p.id, symbol: p.symbol || '',
      }));
    } catch (_) {}
    toCs({ type: 'status', state: 'open' });
  };

  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    toCs({ type: 'ws', payload: d });
  };

  ws.onclose = () => toCs({ type: 'status', state: 'closed' });
  ws.onerror = () => toCs({ type: 'status', state: 'error' });
}
