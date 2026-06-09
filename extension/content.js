// TradingView Squad — content script
// One overlay element with THREE mutually-exclusive sizes (min → panel → large).
// WebRTC mesh for voice + camera + screen share. Pin any video/screen to focus it.
// Opt-in trade detection (accurate BUY/SELL with entry price, P&L, time) + callouts.
// Signaling relays through the background service worker.

(() => {
  if (window.__tvSquadLoaded) return;
  window.__tvSquadLoaded = true;

  // ---- state ----------------------------------------------------------------
  const myId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  let myName = '', room = '';
  let connected = false;
  let muted = true;
  let localStream = null, camStream = null, screenStream = null;
  let currentSymbol = '';
  let audioCtx = null, selfAnalyser = null, selfData = null, selfSpeaking = false;
  let shareTrades = false;
  let view = 'panel';          // 'min' | 'panel' | 'large'  (exactly one at a time)
  let lastSize = 'panel';      // last non-minimized size to restore to
  let pinnedStreamId = null;   // focused video/screen stream
  let co = { side: 'buy', kind: 'stock', opt: 'call', order: 'market' };
  let tradeFilter = 'all';     // all | buy | sell | call | put | stock
  let dead = false;            // set when the extension context is invalidated
  let symbolTimer = null;
  let tradeHintShown = false;
  let roomLabel = '';          // display label for the current room
  let isPublic = false;        // joined a symbol-based public room
  let followChart = false;     // public: auto-switch room as the chart changes
  let joinMode = 'private';    // join form tab: 'private' | 'public'
  let connecting = false;      // a connect attempt is in flight
  let switching = false;       // an intentional room switch is in flight
  let minMode = 'speaker';     // minimized view: 'speaker' (active speaker) | 'multi'
  let activeSpeaker = null;    // id of current/last speaker ('self' or a peer id)
  const DEFAULT_SERVER = 'wss://tradingview-squad-signaling.onrender.com'; // overridden by Settings → Server URL
  let serverUrl = DEFAULT_SERVER;
  let manualSize = {};         // per-view manual {w,h} from dragging the resize grip
  const peers = new Map();

  // ---- background bridge ----------------------------------------------------
  // After the extension is reloaded/updated, this old injected script's chrome.*
  // APIs become invalid. Detect that and shut down quietly instead of throwing.
  function contextAlive() { try { return !dead && chrome.runtime && !!chrome.runtime.id; } catch (_) { return false; } }
  function die() {
    if (dead) return; dead = true;
    try { if (symbolTimer) clearInterval(symbolTimer); } catch (_) {}
    try { if (tradeTimer) clearInterval(tradeTimer); } catch (_) {}
    try { if (tradeObserver) tradeObserver.disconnect(); } catch (_) {}
    setStatus && setStatus('Extension reloaded — refresh this tab');
  }
  function bg(msg) {
    if (!contextAlive()) { die(); return; }
    try { chrome.runtime.sendMessage(Object.assign({ to: 'bg' }, msg), () => { void chrome.runtime.lastError; }); }
    catch (_) { die(); }
  }
  function storageSet(o) { try { if (contextAlive() && chrome.storage) chrome.storage.local.set(o); } catch (_) {} }
  function storageGet(keys, cb) { try { if (contextAlive() && chrome.storage) chrome.storage.local.get(keys, cb); } catch (_) {} }
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.to !== 'cs') return;
      if (m.type === 'ws') handleServer(m.payload);
      else if (m.type === 'status') handleStatus(m.state);
    });
  } catch (_) {}
  function sendSignal(to, data) { bg({ type: 'ws', payload: { type: 'signal', to, data } }); }
  function mediaMap() { return { cam: camStream ? camStream.id : null, screen: screenStream ? screenStream.id : null }; }
  function sendPresence() { if (connected) bg({ type: 'ws', payload: { type: 'presence', symbol: currentSymbol, positions: shareTrades ? myPositions : [], media: mediaMap() } }); }

  // ---- symbol detection -----------------------------------------------------
  function detectSymbol() {
    // DOM first — these reflect the CURRENT chart and update live when you switch
    // symbols. (The URL's ?symbol= is only set on initial load and goes stale.)
    for (const q of ['#header-toolbar-symbol-search', '[data-symbol-short]', '[class*="symbolNameText"]', '[class*="symbolTitle"]']) {
      const el = document.querySelector(q);
      if (el) { const t = (el.getAttribute && el.getAttribute('data-symbol-short')) || el.textContent; if (t && t.trim()) return t.trim().split(',')[0].trim(); }
    }
    const m = document.title.match(/^([A-Z0-9:._-]{2,})/);
    if (m) return m[1];
    try { const u = new URL(location.href); const s = u.searchParams.get('symbol'); if (s) return decodeURIComponent(s); } catch (_) {}
    return '';
  }
  function pollSymbol() {
    if (dead) { if (symbolTimer) clearInterval(symbolTimer); return; }
    const s = detectSymbol();
    if (s && s !== currentSymbol) {
      currentSymbol = s;
      if (connected && isPublic && followChart) {
        const tk = tickerOf(s);
        if (tk && 'pub:' + tk !== room) { switchPublicRoom(tk); return; }
      }
      sendPresence(); renderRoster();
    }
  }
  symbolTimer = setInterval(pollSymbol, 1000);

  // ---- WebRTC ---------------------------------------------------------------
  // STUN for direct connections; TURN relays as a fallback when both peers are
  // behind strict NATs (typical home routers). OpenRelay is a free public TURN —
  // fine for testing; swap in your own for production reliability.
  const RTC_CONFIG = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ] };
  function makePeer(id, name, symbol, polite, positions, media) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = { id, name, symbol, pc, polite, makingOffer: false, ignoreOffer: false, speaking: false, audioEl: null, analyser: null, data: null, videoStreams: new Map(), media: media || {}, positions: positions || [] };
    peers.set(id, peer);
    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    if (camStream) camStream.getVideoTracks().forEach((t) => pc.addTrack(t, camStream));
    if (screenStream) screenStream.getVideoTracks().forEach((t) => pc.addTrack(t, screenStream));
    pc.onnegotiationneeded = async () => { try { peer.makingOffer = true; await pc.setLocalDescription(); sendSignal(id, { description: pc.localDescription }); } catch (e) { console.warn('[squad]', e); } finally { peer.makingOffer = false; } };
    pc.onicecandidate = ({ candidate }) => { if (candidate) sendSignal(id, { candidate }); };
    pc.ontrack = (ev) => handleTrack(peer, ev);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && pc.restartIce) pc.restartIce(); };
    renderRoster();
    return peer;
  }
  async function onSignal(from, data) {
    let peer = peers.get(from); if (!peer) peer = makePeer(from, '…', '', true);
    const pc = peer.pc;
    try {
      if (data.description) {
        const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision; if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') { await pc.setLocalDescription(); sendSignal(from, { description: pc.localDescription }); }
      } else if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; } }
    } catch (e) { console.warn('[squad] signal', e); }
  }
  function handleTrack(peer, ev) {
    const track = ev.track;
    if (track.kind === 'audio') {
      if (!peer.audioEl) { peer.audioEl = new Audio(); peer.audioEl.autoplay = true; }
      peer.audioEl.srcObject = ev.streams[0]; peer.audioEl.play().catch(() => {});
      setupAnalyser(peer, ev.streams[0]);
    } else {
      const stream = ev.streams[0];
      peer.videoStreams.set(stream.id, stream);
      track.onended = () => { peer.videoStreams.delete(stream.id); renderMedia(); };
      renderMedia();
    }
  }
  function closePeer(id) {
    const peer = peers.get(id); if (!peer) return;
    try { peer.pc.close(); } catch (_) {}
    if (peer.audioEl) { peer.audioEl.srcObject = null; peer.audioEl = null; }
    peers.delete(id); renderRoster(); renderMedia();
  }

  // ---- speaking detection ---------------------------------------------------
  function ensureAudioCtx() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); return audioCtx; }
  function setupAnalyser(peer, stream) { try { const ac = ensureAudioCtx(); const an = ac.createAnalyser(); an.fftSize = 512; ac.createMediaStreamSource(stream).connect(an); peer.analyser = an; peer.data = new Uint8Array(an.frequencyBinCount); } catch (_) {} }
  function avg(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function vuLoop() {
    if (dead) return;
    let changed = false;
    for (const peer of peers.values()) if (peer.analyser) { peer.analyser.getByteFrequencyData(peer.data); const s = avg(peer.data) > 12; if (s !== peer.speaking) { peer.speaking = s; changed = true; } }
    if (selfAnalyser) { selfAnalyser.getByteFrequencyData(selfData); const s = avg(selfData) > 12 && !muted; if (s !== selfSpeaking) { selfSpeaking = s; changed = true; } }
    // Track the active speaker (sticky — stays on the last talker when silent).
    let spk = null;
    for (const peer of peers.values()) if (peer.speaking) { spk = peer.id; break; }
    if (!spk && selfSpeaking) spk = 'self';
    if (spk && spk !== activeSpeaker) { activeSpeaker = spk; changed = true; }
    if (changed) updateSpeaking();
    requestAnimationFrame(vuLoop);
  }
  requestAnimationFrame(vuLoop);

  // ---- trade detection ------------------------------------------------------
  let myPositions = [];
  let tradeTimer = null, tradeObserver = null, tradeDebounce = null;
  const feed = [];
  const HEADER_RE = { symbol: /symbol|instrument|ticker/i, side: /side|direction/i, qty: /qty|quantity|size|amount|contracts|shares|units|pos/i, avg: /avg|average|entry|open price|price/i, pnl: /p\s*\/?\s*l|p&l|profit|pnl|gain/i };
  function num(t) { if (t == null || t === '') return null; const m = String(t).replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
  function normSide(t, qty) { const s = (t || '').toLowerCase(); if (/sell|short/.test(s)) return 'short'; if (/buy|long/.test(s)) return 'long'; if (qty != null) return qty < 0 ? 'short' : 'long'; return ''; }
  function gridRows(g) { let r = [...g.querySelectorAll('[role="row"]')]; if (!r.length && g.tagName === 'TABLE') r = [...g.querySelectorAll('tr')]; return r; }
  function rowCells(row) { let c = [...row.querySelectorAll('[role="gridcell"],[role="cell"],[role="columnheader"]')]; if (!c.length) c = [...row.querySelectorAll('td,th')]; return c.map((x) => x.textContent.trim()); }
  function findPositionsTable() {
    for (const g of document.querySelectorAll('[role="table"],[role="grid"],table')) {
      const rows = gridRows(g); if (!rows.length) continue;
      const headerRow = rows.find((r) => r.querySelector('[role="columnheader"],th')) || rows[0];
      const headers = rowCells(headerRow); const col = {};
      headers.forEach((h, i) => { for (const k in HEADER_RE) if (col[k] == null && HEADER_RE[k].test(h)) col[k] = i; });
      if (col.symbol == null) continue;
      if (col.side == null && col.qty == null && col.pnl == null) continue;
      if (window.__tvSquadDebug) console.log('[squad] positions table', col, headers);
      return { col, dataRows: rows.filter((r) => r !== headerRow) };
    }
    return null;
  }
  function scanPositions() {
    const t = findPositionsTable(); if (!t) return null;
    const out = [];
    for (const r of t.dataRows) {
      const cells = rowCells(r);
      const symbol = t.col.symbol != null ? cells[t.col.symbol] : '';
      if (!symbol || /^(total|—|-)?$/i.test(symbol)) continue;
      const qty = t.col.qty != null ? num(cells[t.col.qty]) : null;
      out.push({ symbol, side: normSide(t.col.side != null ? cells[t.col.side] : '', qty), qty, avg: t.col.avg != null ? num(cells[t.col.avg]) : null, pnl: t.col.pnl != null ? num(cells[t.col.pnl]) : null });
    }
    return out;
  }
  // BUY/SELL is what the trader actually did, derived from event + position side.
  function tradeAction(event, side) {
    const long = side !== 'short';
    if (event === 'entry' || event === 'add') return long ? 'buy' : 'sell';
    return long ? 'sell' : 'buy'; // exit / reduce
  }
  function tradeTick() {
    const found = scanPositions();
    if (found == null) return;
    const prev = new Map(myPositions.map((p) => [`${p.symbol}|${p.side}`, p]));
    const next = new Map(found.map((p) => [`${p.symbol}|${p.side}`, p]));
    for (const [k, p] of next) { if (!prev.has(k)) emitTrade('entry', p); else if (prev.get(k).qty !== p.qty) emitTrade(p.qty > prev.get(k).qty ? 'add' : 'reduce', p); }
    for (const [k, p] of prev) if (!next.has(k)) emitTrade('exit', p);
    myPositions = found; sendPresence(); renderRoster();
  }
  function emitTrade(event, p) {
    const payload = { event, symbol: p.symbol, side: p.side, qty: p.qty, avg: p.avg, pnl: p.pnl };
    bg({ type: 'ws', payload: Object.assign({ type: 'trade' }, payload) });
    pushFeed(Object.assign({ type: 'trade', who: 'You', action: tradeAction(event, p.side) }, payload));
  }
  function startTradeWatch() {
    if (tradeTimer) return; myPositions = [];
    tradeTimer = setInterval(tradeTick, 2000);
    try { tradeObserver = new MutationObserver(() => { clearTimeout(tradeDebounce); tradeDebounce = setTimeout(tradeTick, 250); }); tradeObserver.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    tradeTick();
  }
  function stopTradeWatch() { if (tradeTimer) { clearInterval(tradeTimer); tradeTimer = null; } if (tradeObserver) { try { tradeObserver.disconnect(); } catch (_) {} tradeObserver = null; } clearTimeout(tradeDebounce); myPositions = []; sendPresence(); }
  function toggleShareTrades() { shareTrades = !shareTrades; tradeHintShown = false; storageSet({ tvSquadShareTrades: shareTrades }); if (shareTrades && connected) startTradeWatch(); else stopTradeWatch(); renderControls(); renderRoster(); }
  function pushFeed(item) { item.ts = Date.now(); feed.unshift(item); if (feed.length > 16) feed.pop(); renderFeed(); }

  // ---- callouts -------------------------------------------------------------
  function sendCallout() {
    const symbol = ($('coSymbol').value || '').trim().toUpperCase();
    if (!symbol) { $('coSymbol').focus(); return; }
    const payload = { type: 'callout', side: co.side, inst: co.kind, symbol, order: co.order, price: num($('coPrice') && $('coPrice').value), qty: num($('coQty') && $('coQty').value) };
    if (co.kind === 'option') { payload.opt = co.opt; payload.strike = num($('coStrike').value); payload.expiry = ($('coExpiry').value || '').trim(); }
    bg({ type: 'ws', payload });
    pushFeed(Object.assign({ who: 'You' }, payload));
    closeCallout();
  }
  function closeCallout() { const f = $('calloutForm'); if (f) f.classList.add('hidden'); ['coSymbol', 'coStrike', 'coExpiry', 'coPrice', 'coQty'].forEach((id) => { const e = $(id); if (e) e.value = ''; }); }
  function updateCalloutVis() { const o = $('optRow'); if (o) o.classList.toggle('hidden', co.kind !== 'option'); const p = $('priceRow'); if (p) p.classList.toggle('hidden', co.order === 'market'); }

  // ---- server messages ------------------------------------------------------
  function handleServer(msg) {
    if (msg.type === 'joined') { for (const p of msg.peers) makePeer(p.id, p.name, p.symbol, false, p.positions, p.media); }
    else if (msg.type === 'peer-joined') { const p = msg.peer; if (!peers.has(p.id)) { makePeer(p.id, p.name, p.symbol, true, p.positions, p.media); pushFeed({ type: 'sys', text: `${p.name} joined` }); } }
    else if (msg.type === 'peer-left') { const pe = peers.get(msg.id); if (pe) pushFeed({ type: 'sys', text: `${pe.name} left` }); closePeer(msg.id); }
    else if (msg.type === 'presence') { const peer = peers.get(msg.id); if (peer) { peer.symbol = msg.symbol; peer.positions = msg.positions || []; peer.media = msg.media || {}; renderRoster(); renderMedia(); } }
    else if (msg.type === 'trade') { const peer = peers.get(msg.id); pushFeed({ type: 'trade', who: peer ? peer.name : 'Someone', action: tradeAction(msg.event, msg.side), event: msg.event, symbol: msg.symbol, side: msg.side, avg: msg.avg, pnl: msg.pnl }); }
    else if (msg.type === 'callout') { const peer = peers.get(msg.id); pushFeed(Object.assign({ who: peer ? peer.name : 'Someone' }, msg)); }
    else if (msg.type === 'signal') { onSignal(msg.from, msg.data); }
  }
  function handleStatus(state) {
    if (state === 'open') { connected = true; connecting = false; switching = false; applyView(); if (shareTrades) startTradeWatch(); }
    else if (state === 'closed' || state === 'error') {
      if (switching) return; // expected while moving between rooms
      if (connected) teardown(state === 'error' ? 'Connection error' : 'Disconnected');
      else if (connecting) { connecting = false; setStatus("Can't reach server. Is it running on localhost:8080?"); }
    }
  }

  // ---- public rooms ---------------------------------------------------------
  // A public room is keyed by the bare ticker so everyone viewing the same symbol
  // lands together (e.g. AMEX:SPY and SPY both -> "pub:SPY").
  function tickerOf(sym) { if (!sym) return ''; return sym.split(':').pop().replace(/[^A-Za-z0-9._-]/g, '').toUpperCase(); }
  function joinPublic() {
    const tk = tickerOf(detectSymbol());
    if (!tk) { setStatus('Open a chart first'); return; }
    isPublic = true; room = 'pub:' + tk; roomLabel = '🌐 ' + tk;
    join();
  }
  function switchPublicRoom(tk) {
    switching = true;
    room = 'pub:' + tk; roomLabel = '🌐 ' + tk;
    for (const id of [...peers.keys()]) closePeer(id);
    feed.length = 0;
    bg({ type: 'open', room, name: myName, id: myId, symbol: currentSymbol, url: serverUrl });
    renderBody();
  }

  // ---- join / leave ---------------------------------------------------------
  async function join() {
    if (!myName || !room) return; connecting = true; setStatus('Connecting…');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const t = localStream.getAudioTracks()[0]; if (t) t.enabled = !muted;
      const ac = ensureAudioCtx(); selfAnalyser = ac.createAnalyser(); selfAnalyser.fftSize = 512;
      ac.createMediaStreamSource(localStream).connect(selfAnalyser); selfData = new Uint8Array(selfAnalyser.frequencyBinCount);
    } catch (_) { localStream = null; setStatus('Mic blocked — presence only'); }
    currentSymbol = detectSymbol();
    storageSet({ tvSquadName: myName, tvSquadRoom: room });
    bg({ type: 'open', room, name: myName, id: myId, symbol: currentSymbol, url: serverUrl });
  }
  function teardown(reason) {
    connected = false; stopTradeWatch(); bg({ type: 'close' });
    for (const id of [...peers.keys()]) closePeer(id);
    [screenStream, camStream, localStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
    screenStream = camStream = localStream = null; selfAnalyser = null; pinnedStreamId = null; view = 'panel';
    isPublic = false; followChart = false; roomLabel = ''; connecting = false; switching = false;
    applyView(); if (reason) setStatus(reason);
  }

  // ---- media toggles --------------------------------------------------------
  function addLocalVideo(stream) { const vt = stream.getVideoTracks()[0]; for (const peer of peers.values()) peer.pc.addTrack(vt, stream); sendPresence(); renderControls(); renderMedia(); }
  function removeLocalVideo(stream) { const vt = stream.getVideoTracks()[0]; for (const peer of peers.values()) { const s = peer.pc.getSenders().find((x) => x.track === vt); if (s) peer.pc.removeTrack(s); } stream.getTracks().forEach((t) => t.stop()); }
  function toggleMute() { muted = !muted; if (localStream) { const t = localStream.getAudioTracks()[0]; if (t) t.enabled = !muted; } renderControls(); renderRoster(); }
  async function toggleCam() {
    if (camStream) { removeLocalVideo(camStream); camStream = null; sendPresence(); renderControls(); renderMedia(); return; }
    try { camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch (_) { return; }
    camStream.getVideoTracks()[0].onended = () => { camStream = null; renderControls(); renderMedia(); };
    addLocalVideo(camStream);
  }
  async function toggleScreen() {
    if (screenStream) { removeLocalVideo(screenStream); screenStream = null; sendPresence(); renderControls(); renderMedia(); return; }
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); } catch (_) { return; }
    screenStream.getVideoTracks()[0].onended = () => { screenStream = null; sendPresence(); renderControls(); renderMedia(); };
    addLocalVideo(screenStream);
  }

  // ===========================================================================
  //  UI
  // ===========================================================================
  const ICON = (p) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    mic: ICON('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
    micOff: ICON('<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/>'),
    cam: ICON('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>'),
    camOff: ICON('<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>'),
    screen: ICON('<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    invite: ICON('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>'),
    leave: ICON('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
    min: ICON('<line x1="5" y1="12" x2="19" y2="12"/>'),
    expand: ICON('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
    shrink: ICON('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>'),
    pin: ICON('<path d="M9 4h6l-1 7 3 2v2h-5v5l-1 1-1-1v-5H4v-2l3-2-1-7z"/>'),
    gear: ICON('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  };

  const host = document.createElement('div');
  host.id = 'tv-squad-root';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);
  ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste'].forEach((t) => shadow.addEventListener(t, (e) => e.stopPropagation()));

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .panel { position: fixed; right: 16px; bottom: 16px; background: #16181d; color: #e8eaed; border: 1px solid #262a32;
      border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.5); overflow: hidden; font-size: 13px;
      display: flex; flex-direction: column; max-height: 92vh; }
    .rgrip { position: absolute; top: 0; left: 0; width: 18px; height: 18px; cursor: nwse-resize; z-index: 6; }
    .rgrip::before { content: ''; position: absolute; top: 6px; left: 6px; width: 7px; height: 7px; border-top: 2px solid #4a5160; border-left: 2px solid #4a5160; border-top-left-radius: 3px; }
    .rgrip:hover::before { border-color: #7db8ff; }
    .size-min .rgrip { display: none; }
    .panel.size-panel { width: 304px; }
    .panel.size-large { width: min(920px, 92vw); height: min(640px, 88vh); display: flex; flex-direction: column; }
    .panel.size-large .body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    .panel.size-min { width: auto; cursor: pointer; }
    .panel.size-min .hdr { display: none; }
    .panel.size-min .body { padding: 0; }

    .hdr { display: flex; align-items: center; gap: 8px; padding: 12px 14px; user-select: none; flex: 0 0 auto; border-bottom: 1px solid #20242b; }
    .hdr .title { font-weight: 650; flex: 1; letter-spacing: .2px; }
    .hdr .code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8b919c; background: #0f1115; border: 1px solid #262a32; border-radius: 6px; padding: 2px 7px; }
    .ix { background: none; border: none; color: #8b919c; cursor: pointer; padding: 4px; border-radius: 7px; display: flex; }
    .ix:hover { background: #222630; color: #e8eaed; }
    .body { padding: 14px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }

    .field { display: block; width: 100%; margin: 0 0 8px; padding: 10px 11px; background: #0f1115; border: 1px solid #262a32; border-radius: 9px; color: #e8eaed; font-size: 13px; }
    .field.sm { padding: 7px 9px; margin-bottom: 6px; font-size: 12px; }
    .field:focus { outline: none; border-color: #3b82f6; }
    .row { display: flex; gap: 6px; } .row > .field { flex: 1; }
    .btn { flex: 1; padding: 10px; border: none; border-radius: 9px; cursor: pointer; font-size: 13px; font-weight: 650; }
    .btn.primary { background: #3b82f6; color: #fff; } .btn.primary:hover { background: #2f74e6; }
    .btn.ghost { background: #21262e; color: #cbd2da; } .btn.ghost:hover { background: #2a313b; }
    .hint { color: #6f7682; font-size: 11px; margin: 8px 2px 0; } .status { color: #8b919c; font-size: 11px; margin-top: 8px; min-height: 14px; }
    .jtabs { display: flex; gap: 6px; margin-bottom: 10px; }
    .jtab { flex: 1; padding: 8px; border: none; border-radius: 9px; background: #21262e; color: #9aa0aa; font-weight: 650; font-size: 13px; cursor: pointer; }
    .jtab.sel { background: #2563eb; color: #fff; }
    .pubsym { background: #18222f; border: 1px solid #2b3a4d; border-radius: 9px; padding: 13px; text-align: center; font-size: 14px; margin-bottom: 8px; color: #e8eaed; }
    .pubsym .off { color: #6f7682; font-size: 12px; }
    .chk { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #9aa0aa; margin-bottom: 8px; cursor: pointer; }
    .chk input { accent-color: #2563eb; }

    .rhd { font-size: 10px; color: #7a818c; text-transform: uppercase; letter-spacing: .6px; font-weight: 700; margin: 0 2px 8px; }
    ul.roster { list-style: none; margin: 0; padding: 0; max-height: 30vh; overflow-y: auto; }
    ul.roster li { display: flex; align-items: center; gap: 10px; padding: 7px 2px; }
    .ava { width: 30px; height: 30px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; flex: 0 0 auto; position: relative; }
    .ava.spk { box-shadow: 0 0 0 2px #16181d, 0 0 0 4px #22c55e; }
    .ava .md { position: absolute; right: -2px; bottom: -2px; width: 13px; height: 13px; border-radius: 50%; background: #16181d; display: flex; align-items: center; justify-content: center; }
    .ava .md svg { width: 9px; height: 9px; }
    .who { flex: 1; min-width: 0; } .who .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .who .you { color: #6f7682; font-weight: 400; font-size: 11px; }
    .who .sub { display: flex; align-items: center; gap: 5px; margin-top: 3px; }
    .symtxt { display: inline-flex; align-items: center; gap: 4px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #cbd2da; background: #18222f; border: 1px solid #2b3a4d; border-radius: 6px; padding: 2px 7px; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .symtxt svg { color: #5aa7ff; flex: 0 0 auto; }
    .symtxt.off { color: #5b626d; background: #0f1115; border-color: #262a32; font-style: italic; }
    .who .poswrap { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .pos { font-family: ui-monospace, Menlo, monospace; font-size: 10px; padding: 1px 5px; border-radius: 5px; white-space: nowrap; }
    .pos.long { background: #0f2a1b; color: #4ade80; } .pos.short { background: #2c1417; color: #f87171; }
    .rpin { background: none; border: none; color: #4a5160; cursor: pointer; padding: 2px; border-radius: 6px; display: flex; flex: 0 0 auto; }
    .rpin:hover { color: #cbd2da; } .rpin.on { color: #fbbf24; }

    .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 12px 0 0; }
    .tiles:empty { display: none; }
    .tile { position: relative; border-radius: 9px; overflow: hidden; background: #000; border: 1px solid #262a32; }
    .tile.pinned { grid-column: 1 / -1; border-color: #fbbf24; }
    .tile video { width: 100%; display: block; aspect-ratio: 16/9; object-fit: cover; cursor: pointer; }
    .tile .tlabel { position: absolute; left: 5px; bottom: 5px; font-size: 10px; background: rgba(0,0,0,.6); padding: 1px 6px; border-radius: 5px; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tile .pinbtn { position: absolute; right: 5px; top: 5px; background: rgba(0,0,0,.55); color: #fff; border: none; border-radius: 6px; padding: 3px; cursor: pointer; display: flex; opacity: .85; }
    .tile .pinbtn.on { background: #fbbf24; color: #1a1a1a; }
    .panel.size-large .tiles { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); margin-top: 0; }

    .bar { display: flex; gap: 10px; justify-content: center; margin-top: 14px; padding-top: 14px; border-top: 1px solid #20242b; flex: 0 0 auto; }
    .ic { width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer; background: #21262e; color: #e8eaed; display: flex; align-items: center; justify-content: center; }
    .ic:hover { background: #2a313b; } .ic.on { background: #2563eb; color: #fff; } .ic.muted { background: #3a2024; color: #f87171; }
    .ic.danger { background: #3a2024; color: #f87171; } .ic.danger:hover { background: #4a262b; }

    .trades { margin-top: 14px; padding-top: 14px; border-top: 1px solid #20242b; }
    .tradesHead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .tradesHead .lab { font-size: 10px; color: #7a818c; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; }
    .switch { display: flex; align-items: center; gap: 7px; cursor: pointer; }
    .switch .swtxt { font-size: 11px; color: #8b919c; } .switch.on .swtxt { color: #4ade80; }
    .track { width: 32px; height: 18px; border-radius: 999px; background: #2a2f38; position: relative; transition: background .15s; }
    .switch.on .track { background: #16a34a; }
    .knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .15s; }
    .switch.on .knob { left: 16px; }
    .calloutBtn { width: 100%; padding: 8px; border: 1px dashed #303642; background: #0f1115; color: #9aa0aa; border-radius: 9px; cursor: pointer; font-size: 12px; font-weight: 600; margin-bottom: 8px; }
    .calloutBtn:hover { border-color: #3b82f6; color: #cbd2da; }
    .calloutForm { background: #0f1115; border: 1px solid #262a32; border-radius: 10px; padding: 9px; margin-bottom: 8px; }
    .seg { display: flex; gap: 4px; margin-bottom: 6px; }
    .seg button { flex: 1; padding: 6px; border: 1px solid #262a32; background: #16181d; color: #9aa0aa; border-radius: 7px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .seg button.sel { background: #2563eb; color: #fff; border-color: #2563eb; }
    .seg button[data-v="sell"].sel, .seg button[data-v="put"].sel { background: #dc2626; border-color: #dc2626; }

    .feed { display: flex; flex-direction: column; gap: 2px; max-height: 26vh; overflow-y: auto; }
    .tfilter { display: flex; gap: 5px; margin-bottom: 10px; overflow-x: auto; }
    .tfilter button { padding: 4px 9px; border: none; border-radius: 999px; background: #21262e; color: #8b919c; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .tfilter button.sel { background: #e8eaed; color: #16181d; }
    .trow { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 9px; }
    .trow:hover { background: #0f1115; }
    .ttag { font-size: 9px; font-weight: 800; padding: 2px 6px; border-radius: 5px; letter-spacing: .3px; flex: 0 0 auto; }
    .ttag.buy { background: #0f2a1b; color: #4ade80; } .ttag.sell { background: #2c1417; color: #f87171; }
    .tleft { flex: 1; min-width: 0; } .tright { text-align: right; flex: 0 0 auto; }
    .tsym { font-weight: 700; font-size: 13px; color: #e8eaed; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tsub { font-size: 10.5px; color: #6f7682; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tval { font-size: 12px; font-weight: 600; color: #cbd2da; font-family: ui-monospace, Menlo, monospace; }
    .tsub2 { font-size: 11px; margin-top: 1px; }
    .opt { font-family: ui-monospace, Menlo, monospace; font-size: 11px; padding: 0 4px; border-radius: 4px; }
    .opt.call { background: #0f2a1b; color: #4ade80; } .opt.put { background: #2c1417; color: #f87171; }
    .fempty { font-size: 11px; color: #5b626d; text-align: center; padding: 12px; }
    .fitem { display: flex; align-items: center; gap: 7px; font-size: 11px; color: #cbd2da; background: #0f1115; border-radius: 7px; padding: 5px 8px; }
    .act { font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 4px; flex: 0 0 auto; letter-spacing: .3px; }
    .act.buy { background: #0f2a1b; color: #4ade80; } .act.sell { background: #2c1417; color: #f87171; }
    .ftext { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .ftext b { color: #e8eaed; }
    .pnl.up { color: #4ade80; } .pnl.down { color: #f87171; }
    .ftime { color: #5b626d; font-size: 10px; }
    .fsys { font-size: 10.5px; color: #6f7682; text-align: center; padding: 2px; }
    .callout { border-radius: 8px; padding: 6px 9px; border-left: 3px solid #2563eb; background: #11161f; }
    .callout.sell { border-left-color: #dc2626; }
    .callout .cohead { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 2px; }
    .cotag { font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 4px; background: #1d3a5f; color: #93c5fd; }
    .callout.sell .cotag { background: #3a1518; color: #fca5a5; }
    .coline { font-size: 12px; color: #e8eaed; } .coline .dim { color: #8b919c; font-size: 11px; }
    .coline .opt { font-family: ui-monospace, Menlo, monospace; padding: 0 4px; border-radius: 4px; }
    .coline .opt.call { background: #0f2a1b; color: #4ade80; } .coline .opt.put { background: #2c1417; color: #f87171; }

    .lwrap { flex: 1; display: flex; gap: 12px; min-height: 0; padding-top: 4px; }
    .lmain { flex: 1; min-width: 0; overflow-y: auto; }
    .lside { width: 272px; flex: 0 0 auto; overflow-y: auto; border-left: 1px solid #20242b; padding-left: 12px; }

    .minwrap.minavs { display: flex; align-items: center; padding: 7px 11px; }
    .minwrap.minsolo { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 14px 18px; }
    .ava.big { width: 46px; height: 46px; font-size: 17px; }
    .mname { font-size: 12px; font-weight: 600; color: #e8eaed; max-width: 130px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .minwrap.minvid { position: relative; width: 188px; height: 106px; }
    .minwrap.minvid video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .minwrap.minvid .mvlabel { position: absolute; left: 6px; bottom: 6px; font-size: 10px; background: rgba(0,0,0,.62); color: #fff; padding: 1px 6px; border-radius: 5px; max-width: 80%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .minctl { position: absolute; top: 6px; right: 6px; display: flex; gap: 6px; opacity: 0; transition: opacity .12s; }
    .minwrap.minvid:hover .minctl { opacity: 1; }
    .mc { width: 30px; height: 30px; border-radius: 50%; border: none; cursor: pointer; background: rgba(0,0,0,.55); color: #fff; display: flex; align-items: center; justify-content: center; }
    .mc:hover { background: rgba(0,0,0,.78); }
    .mc svg { width: 15px; height: 15px; }
    .mc.muted { background: #dc2626; } .mc.on { background: #2563eb; }
    .settings { position: absolute; top: 50px; right: 12px; width: 248px; background: #1b1e25; border: 1px solid #2b303a; border-radius: 10px; padding: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.5); z-index: 5; display: flex; flex-direction: column; gap: 12px; }
    .srow { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    .srow.col { flex-direction: column; align-items: stretch; gap: 6px; }
    .slbl { font-size: 12px; color: #cbd2da; }
    .sinput { width: 100%; padding: 8px 10px; background: #0f1115; border: 1px solid #2b303a; border-radius: 8px; color: #e8eaed; font-size: 12px; font-family: ui-monospace, Menlo, monospace; }
    .sinput:focus { outline: none; border-color: #3b82f6; }
    .snote { font-size: 10.5px; color: #6f7682; }
    .segmm { display: flex; gap: 4px; }
    .segmm button { padding: 5px 9px; border: 1px solid #2b303a; background: #0f1115; color: #9aa0aa; border-radius: 7px; font-size: 11px; font-weight: 600; cursor: pointer; }
    .segmm button.sel { background: #2563eb; color: #fff; border-color: #2563eb; }
    .pov { position: absolute; left: 6px; bottom: 6px; display: flex; }
    .pava { width: 28px; height: 28px; border-radius: 50%; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 11px; margin-left: -8px; border: 2px solid #16181d; }
    .pova .pava { width: 22px; height: 22px; font-size: 10px; } .pava:first-child { margin-left: 0; } .pava.spk { border-color: #22c55e; }
    .pov .pava { width: 22px; height: 22px; font-size: 10px; border-color: rgba(0,0,0,.5); }

    .modal { position: fixed; inset: 0; background: rgba(0,0,0,.8); display: flex; align-items: center; justify-content: center; }
    .modal video { max-width: 92vw; max-height: 88vh; border-radius: 12px; }
    .hidden { display: none !important; }
  `;

  shadow.innerHTML = `
    <style>${STYLE}</style>
    <div class="panel size-panel" id="panel">
      <div class="rgrip" id="rgrip" title="Drag to resize"></div>
      <div class="hdr" id="hdr">
        <span class="title">TradingView Squad</span>
        <span class="code hidden" id="hdrCode"></span>
        <button class="ix" id="gearBtn" title="Settings">${ICONS.gear}</button>
        <button class="ix hidden" id="expandBtn" title="Expand"></button>
        <button class="ix" id="minBtn" title="Minimize">${ICONS.min}</button>
      </div>
      <div class="settings hidden" id="settings">
        <div class="srow"><span class="slbl">Minimized view</span>
          <div class="segmm">
            <button data-mm="speaker">Speaker</button>
            <button data-mm="multi">Everyone</button>
          </div>
        </div>
        <div class="srow col"><span class="slbl">Server URL</span>
          <input class="sinput" id="serverInput" placeholder="wss://your-server… (blank = localhost)">
          <span class="snote">Everyone in a room must use the same server.</span>
        </div>
      </div>
      <div class="body" id="body"></div>
    </div>
    <div class="modal hidden" id="modal"></div>
  `;

  const $ = (id) => shadow.getElementById(id);
  const panel = $('panel');

  // Always docked bottom-right (CSS handles position at every size). Clicking the
  // minimized pill restores it to the last size.
  panel.addEventListener('click', (e) => {
    if (view !== 'min') return;
    if (e.target.closest('button,input')) return;
    setView(lastSize);
  });

  $('expandBtn').addEventListener('click', (e) => { e.stopPropagation(); setView(view === 'large' ? 'panel' : 'large'); });
  $('minBtn').addEventListener('click', (e) => { e.stopPropagation(); setView('min'); });
  function syncSettings() {
    shadow.querySelectorAll('[data-mm]').forEach((x) => x.classList.toggle('sel', x.dataset.mm === minMode));
    const si = $('serverInput'); if (si) si.value = (serverUrl && serverUrl !== DEFAULT_SERVER) ? serverUrl : '';
  }
  $('gearBtn').addEventListener('click', (e) => { e.stopPropagation(); $('settings').classList.toggle('hidden'); syncSettings(); });
  shadow.querySelectorAll('[data-mm]').forEach((b) => b.addEventListener('click', () => { minMode = b.dataset.mm; storageSet({ tvSquadMinMode: minMode }); syncSettings(); if (view === 'min') renderMin(); }));
  $('serverInput').addEventListener('change', () => { serverUrl = $('serverInput').value.trim() || DEFAULT_SERVER; storageSet({ tvSquadServer: serverUrl }); });

  // Manual resize: drag the top-left grip (panel is docked bottom-right, so it
  // grows up-and-left). Size is remembered per view.
  (() => {
    let rs = null;
    $('rgrip').addEventListener('mousedown', (e) => { if (view === 'min') return; rs = { sx: e.clientX, sy: e.clientY, sw: panel.offsetWidth, sh: panel.offsetHeight }; e.preventDefault(); e.stopPropagation(); });
    window.addEventListener('mousemove', (e) => {
      if (!rs) return;
      const w = Math.max(260, Math.min(window.innerWidth * 0.96, rs.sw + (rs.sx - e.clientX)));
      const h = Math.max(220, Math.min(window.innerHeight * 0.92, rs.sh + (rs.sy - e.clientY)));
      panel.style.width = w + 'px'; panel.style.height = h + 'px'; manualSize[view] = { w, h };
    });
    window.addEventListener('mouseup', () => { if (rs) { rs = null; storageSet({ tvSquadSizes: manualSize }); } });
  })();

  function setView(v) { if (v === 'panel' || v === 'large') lastSize = v; view = v; applyView(); }
  function applyView() {
    if (!connected && view === 'large') view = 'panel';
    panel.className = 'panel size-' + view;
    if (view !== 'min' && manualSize[view]) { panel.style.width = manualSize[view].w + 'px'; panel.style.height = manualSize[view].h + 'px'; }
    else { panel.style.width = ''; panel.style.height = ''; }
    const b = $('body'); if (b) { b._minVid = null; }
    if (view === 'min') renderMin(); else renderBody();
  }

  function setStatus(t) { const el = $('statusLine'); if (el) el.textContent = t || ''; }
  function initials(n) { return (n || '?').trim().slice(0, 2).toUpperCase(); }
  function colorFor(n) { let h = 0; const s = n || '?'; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return `hsl(${h} 52% 46%)`; }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }
  function renderMedia() { if (view === 'min') renderMin(); else renderTiles(); }

  // ---- min view -------------------------------------------------------------
  function pinnedStream() {
    if (!pinnedStreamId) return null;
    for (const peer of peers.values()) { const s = peer.videoStreams.get(pinnedStreamId); if (s) return s; }
    if (camStream && camStream.id === pinnedStreamId) return camStream;
    if (screenStream && screenStream.id === pinnedStreamId) return screenStream;
    return null;
  }
  function avatarsHtml() {
    const a = [pillAva(myName, selfSpeaking)];
    for (const peer of peers.values()) a.push(pillAva(peer.name, peer.speaking));
    return a.join('');
  }
  function pillAva(name, spk) { return `<span class="pava ${spk ? 'spk' : ''}" style="background:${colorFor(name)}" title="${escapeHtml(name)}">${escapeHtml(initials(name))}</span>`; }
  function fillMinControls(el) {
    el.innerHTML = '';
    const mk = (cls, html, title, fn) => { const b = document.createElement('button'); b.className = 'mc ' + cls; b.innerHTML = html; b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
    el.appendChild(mk(muted ? 'muted' : '', muted ? ICONS.micOff : ICONS.mic, muted ? 'Unmute' : 'Mute', toggleMute));
    el.appendChild(mk(camStream ? 'on' : '', camStream ? ICONS.cam : ICONS.camOff, 'Camera', toggleCam));
  }
  function pinName() {
    for (const peer of peers.values()) if (peer.videoStreams.has(pinnedStreamId)) return peer.name;
    if (camStream && camStream.id === pinnedStreamId) return myName;
    if (screenStream && screenStream.id === pinnedStreamId) return myName + ' · screen';
    return '';
  }
  // What the minimized "speaker" view shows: pinned > active speaker's video >
  // active speaker's avatar > yourself.
  function minFocus() {
    const pin = pinnedStream(); if (pin) return { video: pin, name: pinName() };
    const id = activeSpeaker;
    if (id === 'self') {
      if (camStream) return { video: camStream, name: myName };
      if (screenStream) return { video: screenStream, name: myName + ' · screen' };
      return { name: myName, spk: selfSpeaking };
    }
    const peer = id && peers.get(id);
    if (peer) {
      const m = peer.media || {};
      const vs = (m.cam && peer.videoStreams.get(m.cam)) || (m.screen && peer.videoStreams.get(m.screen)) || peer.videoStreams.values().next().value || null;
      if (vs) return { video: vs, name: peer.name };
      return { name: peer.name, spk: peer.speaking };
    }
    if (camStream) return { video: camStream, name: myName };
    if (screenStream) return { video: screenStream, name: myName + ' · screen' };
    return { name: myName, spk: selfSpeaking };
  }
  function renderMin() {
    const body = $('body'); if (!body) return;
    if (!connected) { body._minVid = null; body.innerHTML = `<div class="minwrap minavs"><span class="pava" style="background:#2563eb">📈</span></div>`; return; }
    if (minMode === 'multi') { body._minVid = null; body.innerHTML = `<div class="minwrap minavs">${avatarsHtml()}</div>`; return; }
    const f = minFocus();
    if (f.video) {
      if (body._minVid !== f.video) {
        body._minVid = f.video; body.innerHTML = '';
        const wrap = document.createElement('div'); wrap.className = 'minwrap minvid';
        const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = true; v.srcObject = f.video;
        const lbl = document.createElement('div'); lbl.className = 'mvlabel';
        const ctl = document.createElement('div'); ctl.className = 'minctl';
        wrap.appendChild(v); wrap.appendChild(lbl); wrap.appendChild(ctl); body.appendChild(wrap); body._lbl = lbl; body._ctl = ctl;
      }
      if (body._lbl) body._lbl.textContent = f.name || '';
      if (body._ctl) fillMinControls(body._ctl);
    } else {
      body._minVid = null;
      body.innerHTML = `<div class="minwrap minsolo"><div class="ava big ${f.spk ? 'spk' : ''}" style="background:${colorFor(f.name)}">${escapeHtml(initials(f.name))}</div><div class="mname">${escapeHtml(f.name || 'Anon')}</div></div>`;
    }
  }

  // ---- panel / large views --------------------------------------------------
  function barHtml() {
    return `<div class="bar">
      <button class="ic" id="micBtn" title="Mic"></button>
      <button class="ic" id="camBtn" title="Camera"></button>
      <button class="ic" id="screenBtn" title="Share screen"></button>
      <button class="ic" id="inviteBtn" title="Copy invite"></button>
      <button class="ic danger" id="leaveBtn" title="Leave">${ICONS.leave}</button>
    </div>`;
  }
  function tradesHtml() {
    return `<div class="trades">
      <div class="tradesHead"><span class="lab">Trades</span>
        <span class="switch" id="tradeToggle"><span class="swtxt"></span><span class="track"><span class="knob"></span></span></span>
      </div>
      <div class="tfilter" id="tfilter">
        <button data-f="all" class="sel">All</button>
        <button data-f="buy">Buy</button>
        <button data-f="sell">Sell</button>
        <button data-f="call">Call</button>
        <button data-f="put">Put</button>
        <button data-f="stock">Stock</button>
      </div>
      <button class="calloutBtn" id="calloutBtn">＋ Call out a trade</button>
      <div class="calloutForm hidden" id="calloutForm">
        <div class="seg"><button data-group="side" data-v="buy" class="sel">Buy</button><button data-group="side" data-v="sell">Sell</button></div>
        <div class="seg"><button data-group="kind" data-v="stock" class="sel">Stock</button><button data-group="kind" data-v="option">Option</button></div>
        <input class="field sm" id="coSymbol" placeholder="Symbol (e.g. TSLA)" maxlength="14">
        <div class="optRow hidden" id="optRow">
          <div class="seg"><button data-group="opt" data-v="call" class="sel">Call</button><button data-group="opt" data-v="put">Put</button></div>
          <div class="row"><input class="field sm" id="coStrike" placeholder="Strike"><input class="field sm" id="coExpiry" placeholder="Exp MM/DD"></div>
        </div>
        <div class="seg"><button data-group="order" data-v="market" class="sel">Market</button><button data-group="order" data-v="limit">Limit</button><button data-group="order" data-v="stop">Stop</button></div>
        <div class="row priceRow hidden" id="priceRow"><input class="field sm" id="coPrice" placeholder="Price"></div>
        <input class="field sm" id="coQty" placeholder="Qty (optional)">
        <button class="btn primary" id="coSend" style="width:100%">Send callout</button>
      </div>
      <div class="feed" id="feed"></div>
    </div>`;
  }
  function rosterBlock() { return `<div class="rhd" id="rhd"></div><ul class="roster" id="roster"></ul>`; }

  function renderBody() {
    const body = $('body');
    const code = $('hdrCode'); code.classList.toggle('hidden', !connected); if (connected) code.textContent = roomLabel || ('#' + room);
    const eb = $('expandBtn'); eb.classList.toggle('hidden', !connected); eb.innerHTML = view === 'large' ? ICONS.shrink : ICONS.expand; eb.title = view === 'large' ? 'Shrink' : 'Expand';

    if (!connected) {
      const privateRoomVal = (room && !room.startsWith('pub:')) ? room : '';
      const modeBody = joinMode === 'public'
        ? `<div class="pubsym" id="pubsym"></div>
           <label class="chk"><input type="checkbox" id="followChk" ${followChart ? 'checked' : ''}> Follow my chart (auto-switch rooms)</label>
           <button class="btn primary" id="joinPubBtn" style="width:100%">Join community</button>
           <div class="hint">Public room for the chart you're on — hear everyone watching the same symbol.</div>`
        : `<input class="field" id="roomInput" placeholder="Room code" maxlength="24" value="${escapeHtml(privateRoomVal)}">
           <div class="row"><button class="btn primary" id="joinBtn">Join</button><button class="btn ghost" id="newBtn">New room</button></div>
           <div class="hint">Private room — share the code with friends.</div>`;
      body.innerHTML = `
        <div class="jtabs">
          <button class="jtab ${joinMode === 'private' ? 'sel' : ''}" data-jt="private">Private</button>
          <button class="jtab ${joinMode === 'public' ? 'sel' : ''}" data-jt="public">Public</button>
        </div>
        <input class="field" id="nameInput" placeholder="Your name" maxlength="20" value="${escapeHtml(myName)}">
        ${modeBody}
        <div class="status" id="statusLine"></div>`;
      shadow.querySelectorAll('[data-jt]').forEach((b) => b.addEventListener('click', () => { joinMode = b.dataset.jt; renderBody(); }));
      if (joinMode === 'public') {
        const tk = tickerOf(detectSymbol());
        $('pubsym').innerHTML = tk ? `🌐 <b>${escapeHtml(tk)}</b> community` : `<span class="off">Open a chart to pick a community</span>`;
        $('followChk').addEventListener('change', (e) => { followChart = e.target.checked; });
        $('joinPubBtn').addEventListener('click', () => { myName = $('nameInput').value.trim(); followChart = $('followChk').checked; if (myName) joinPublic(); });
      } else {
        $('joinBtn').addEventListener('click', () => { myName = $('nameInput').value.trim(); room = $('roomInput').value.trim(); if (myName && room) { isPublic = false; roomLabel = '#' + room; join(); } });
        $('newBtn').addEventListener('click', () => { $('roomInput').value = randomCode(); });
      }
      storageGet(['tvSquadName'], (r) => { if (r && r.tvSquadName && !$('nameInput').value) $('nameInput').value = r.tvSquadName; });
      return;
    }

    co = { side: 'buy', kind: 'stock', opt: 'call', order: 'market' };
    body.innerHTML = view === 'large'
      ? `<div class="lwrap"><div class="lmain"><div class="tiles" id="tiles"></div></div><div class="lside">${rosterBlock()}${tradesHtml()}</div></div>${barHtml()}`
      : `${rosterBlock()}<div class="tiles" id="tiles"></div>${barHtml()}${tradesHtml()}`;

    attachRoomListeners();
    renderRoster(); renderControls(); renderTiles(); renderFeed();
  }

  function attachRoomListeners() {
    $('micBtn').addEventListener('click', toggleMute);
    $('camBtn').addEventListener('click', toggleCam);
    $('screenBtn').addEventListener('click', toggleScreen);
    $('inviteBtn').addEventListener('click', copyInvite);
    $('leaveBtn').addEventListener('click', () => teardown('Left room'));
    $('tradeToggle').addEventListener('click', toggleShareTrades);
    $('calloutBtn').addEventListener('click', () => $('calloutForm').classList.toggle('hidden'));
    $('coSend').addEventListener('click', sendCallout);
    shadow.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
      const g = b.dataset.group;
      shadow.querySelectorAll(`[data-group="${g}"]`).forEach((x) => x.classList.toggle('sel', x === b));
      co[g] = b.dataset.v; updateCalloutVis();
    }));
    $('roster').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pin]'); if (!b) return;
      const id = b.dataset.pin; pinnedStreamId = pinnedStreamId === id ? null : id; renderMedia(); renderRoster();
    });
    $('tfilter').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      tradeFilter = b.dataset.f;
      shadow.querySelectorAll('#tfilter [data-f]').forEach((x) => x.classList.toggle('sel', x === b));
      renderFeed();
    });
    updateCalloutVis();
  }

  function copyInvite() {
    const text = isPublic
      ? `Join the ${tickerOf(currentSymbol)} live room on TradingView Squad — open ${currentSymbol} on TradingView and pick the Public tab.`
      : `Join my TradingView Squad — room code: ${room}`;
    navigator.clipboard.writeText(text).then(() => setStatus('Invite copied to clipboard')).catch(() => {});
  }

  function avaHtml(name, spk, hasMic) { const md = hasMic ? '' : `<span class="md">${ICONS.micOff}</span>`; return `<div class="ava ${spk ? 'spk' : ''}" style="background:${colorFor(name)}">${escapeHtml(initials(name))}${md}</div>`; }

  function renderRoster() {
    const rhd = $('rhd'); if (rhd) rhd.textContent = `In room · ${peers.size + 1}`;
    const ul = $('roster');
    if (ul) {
      const rows = [rosterRow(myName, currentSymbol, selfSpeaking, true, !muted && !!localStream, shareTrades ? myPositions : [], selfPinId())];
      for (const peer of peers.values()) rows.push(rosterRow(peer.name, peer.symbol, peer.speaking, false, true, peer.positions || [], peerPinId(peer)));
      ul.innerHTML = rows.join('');
    }
    if (view === 'min') renderMin();
  }
  function selfPinId() { return (screenStream && screenStream.id) || (camStream && camStream.id) || null; }
  function peerPinId(peer) { const m = peer.media || {}; if (m.screen && peer.videoStreams.get(m.screen)) return m.screen; if (m.cam && peer.videoStreams.get(m.cam)) return m.cam; const f = peer.videoStreams.keys().next(); return f.done ? null : f.value; }
  function rosterRow(name, symbol, spk, isSelf, hasMic, positions, pinId) {
    const pin = pinId ? `<button class="rpin ${pinnedStreamId === pinId ? 'on' : ''}" data-pin="${pinId}" title="Pin to stage">${ICONS.pin}</button>` : '';
    const eye = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    const sym = symbol ? `<span class="symtxt" title="Viewing ${escapeHtml(symbol)}">${eye}${escapeHtml(symbol)}</span>` : `<span class="symtxt off">No chart open</span>`;
    return `<li>${avaHtml(name, spk, hasMic)}<div class="who"><div class="nm">${escapeHtml(name || 'Anon')}${isSelf ? ' <span class="you">(you)</span>' : ''}</div><div class="sub">${sym}</div></div>${pin}</li>`;
  }
  function updateSpeaking() { if (view === 'min') renderMin(); else renderRoster(); }

  function renderControls() {
    const mic = $('micBtn'); if (mic) { mic.innerHTML = muted ? ICONS.micOff : ICONS.mic; mic.className = 'ic' + (muted ? ' muted' : ' on'); }
    const cam = $('camBtn'); if (cam) { cam.innerHTML = camStream ? ICONS.cam : ICONS.camOff; cam.className = 'ic' + (camStream ? ' on' : ''); }
    const scr = $('screenBtn'); if (scr) { scr.innerHTML = ICONS.screen; scr.className = 'ic' + (screenStream ? ' on' : ''); }
    const inv = $('inviteBtn'); if (inv) inv.innerHTML = ICONS.invite;
    const tg = $('tradeToggle'); if (tg) { tg.classList.toggle('on', shareTrades); const tx = tg.querySelector('.swtxt'); if (tx) tx.textContent = shareTrades ? 'Sharing my trades' : 'Share my trades'; }
  }

  function desiredTiles() {
    const list = [];
    if (camStream) list.push({ id: camStream.id, stream: camStream, label: (myName || 'You') });
    if (screenStream) list.push({ id: screenStream.id, stream: screenStream, label: (myName || 'You') + ' · screen' });
    for (const peer of peers.values()) {
      const m = peer.media || {}; const shown = new Set();
      if (m.cam && peer.videoStreams.get(m.cam)) { list.push({ id: m.cam, stream: peer.videoStreams.get(m.cam), label: peer.name }); shown.add(m.cam); }
      if (m.screen && peer.videoStreams.get(m.screen)) { list.push({ id: m.screen, stream: peer.videoStreams.get(m.screen), label: peer.name + ' · screen' }); shown.add(m.screen); }
      for (const [id, st] of peer.videoStreams) if (!shown.has(id)) list.push({ id, stream: st, label: peer.name });
    }
    if (pinnedStreamId && !list.some((t) => t.id === pinnedStreamId)) pinnedStreamId = null;
    list.sort((a, b) => (b.id === pinnedStreamId ? 1 : 0) - (a.id === pinnedStreamId ? 1 : 0));
    return list;
  }
  function renderTiles() {
    const wrap = $('tiles'); if (!wrap) return;
    const list = desiredTiles();
    const sig = JSON.stringify(list.map((t) => [t.id, t.label, t.id === pinnedStreamId])) + '|' + view;
    if (sig === wrap._sig) return; wrap._sig = sig;
    wrap.innerHTML = '';
    for (const t of list) {
      const tile = document.createElement('div'); tile.className = 'tile' + (t.id === pinnedStreamId ? ' pinned' : '');
      const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = true; v.srcObject = t.stream;
      v.addEventListener('click', () => openModal(t.stream));
      const l = document.createElement('span'); l.className = 'tlabel'; l.textContent = t.label;
      const pb = document.createElement('button'); pb.className = 'pinbtn' + (t.id === pinnedStreamId ? ' on' : ''); pb.innerHTML = ICONS.pin; pb.title = 'Pin';
      pb.addEventListener('click', (e) => { e.stopPropagation(); pinnedStreamId = pinnedStreamId === t.id ? null : t.id; renderMedia(); renderRoster(); });
      tile.appendChild(v); tile.appendChild(l); tile.appendChild(pb); wrap.appendChild(tile);
    }
  }

  function feedMatches(f) {
    if (f.type === 'sys') return tradeFilter === 'all';
    const act = f.action || f.side;
    switch (tradeFilter) {
      case 'buy': return act === 'buy';
      case 'sell': return act === 'sell';
      case 'call': return f.opt === 'call';
      case 'put': return f.opt === 'put';
      case 'stock': return (f.inst || 'stock') === 'stock';
      default: return true;
    }
  }
  function renderFeed() {
    const el = $('feed'); if (!el) return;
    const items = feed.filter(feedMatches);
    el.innerHTML = items.length
      ? items.map((f) => f.type === 'callout' ? calloutRow(f) : f.type === 'sys' ? `<div class="fsys">${escapeHtml(f.text)}</div>` : tradeRow(f)).join('')
      : `<div class="fempty">No ${tradeFilter === 'all' ? 'activity yet' : tradeFilter + ' trades yet'}</div>`;
  }
  function tradeRow(f) {
    const buy = f.action === 'buy';
    const evlab = { entry: 'opened', exit: 'closed', add: 'added', reduce: 'trimmed' }[f.event] || f.event;
    const price = (f.avg != null) ? `@ ${escapeHtml(String(f.avg))}` : '';
    const pnl = (f.event === 'exit' || f.event === 'reduce') && f.pnl != null ? `<span class="pnl ${f.pnl >= 0 ? 'up' : 'down'}">${f.pnl >= 0 ? '+' : ''}${escapeHtml(String(f.pnl))}</span>` : '';
    return `<div class="trow">
      <span class="ttag ${buy ? 'buy' : 'sell'}">${buy ? 'BUY' : 'SELL'}</span>
      <div class="tleft"><div class="tsym">${escapeHtml(f.symbol)}</div><div class="tsub">${escapeHtml(f.who)} · ${evlab} · ${fmtTime(f.ts)}</div></div>
      <div class="tright"><div class="tval">${price}</div><div class="tsub2">${pnl}</div></div>
    </div>`;
  }
  function calloutRow(f) {
    const buy = f.side !== 'sell';
    const opt = f.inst === 'option' ? `<span class="opt ${f.opt === 'put' ? 'put' : 'call'}">${(f.strike != null ? escapeHtml(String(f.strike)) : '') + (f.opt === 'put' ? 'P' : 'C')}</span>` : '';
    const sub = `${escapeHtml(f.who)}${f.inst === 'option' && f.expiry ? ' · ' + escapeHtml(f.expiry) : ''} · ${fmtTime(f.ts)}`;
    const order = f.order === 'market' ? 'MKT' : (f.order || '').toUpperCase() + (f.price != null ? ' ' + escapeHtml(String(f.price)) : '');
    const qty = (f.qty != null) ? `×${escapeHtml(String(f.qty))}` : '';
    return `<div class="trow">
      <span class="ttag ${buy ? 'buy' : 'sell'}">${buy ? 'BUY' : 'SELL'}</span>
      <div class="tleft"><div class="tsym">${escapeHtml(f.symbol)} ${opt}</div><div class="tsub">${sub}</div></div>
      <div class="tright"><div class="tval">${order}</div><div class="tsub2">${qty}</div></div>
    </div>`;
  }

  function openModal(stream) { const modal = $('modal'); modal.innerHTML = ''; const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.srcObject = stream; modal.appendChild(v); modal.classList.remove('hidden'); modal.addEventListener('click', () => modal.classList.add('hidden'), { once: true }); }
  function randomCode() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }

  storageGet(['tvSquadShareTrades', 'tvSquadMinMode', 'tvSquadServer', 'tvSquadSizes'], (r) => {
    shareTrades = !!(r && r.tvSquadShareTrades);
    if (r && r.tvSquadMinMode) minMode = r.tvSquadMinMode;
    if (r && r.tvSquadServer) serverUrl = r.tvSquadServer;
    if (r && r.tvSquadSizes) manualSize = r.tvSquadSizes;
    renderControls(); syncSettings(); applyView();
  });
  applyView();
})();
