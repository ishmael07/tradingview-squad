# TradingTalk

"Discord for your TradingView charts." A Chrome extension that overlays a small,
clean panel on TradingView so you and your friends can:

- **See what chart everyone is on** (BTCUSD, SPY, …) in real time
- **Talk over voice** while you trade
- **Turn on your camera** and **share your screen / a tab / the chart** — with live previews
- **See friends' trades** — entries, exits, and position sizes (opt-in)

- **Call out trades to the room** — a composer for buy/sell, stock/option (call/put,
  strike, expiry), market/limit/stop, price and size; broadcast to everyone instantly

**Three sizes:** minimized (Discord-style avatar pill — shows your video instead when
your camera is on), the small side panel, and a large call view with a big screen-share
stage plus full mic/camera/screen/trade controls. Toggle with the expand/minimize icons.
Controls are a clean icon bar: mic · camera · screen · invite · leave.

Two ways to join:
- **Private room** — share a **room code** with friends (no TradingView account linking;
  that isn't possible for third parties, and no passwords in this v1).
- **Public room** — community voice rooms keyed by ticker. Everyone viewing **SPY** joins
  the SPY room; turn on **Follow my chart** and you auto-move to each symbol's room as you
  switch charts. (Exchange prefix is ignored, so `AMEX:SPY` and `SPY` share one room.)

> Public rooms use a peer-to-peer **mesh**, ideal for small groups. A busy ticker with many
> people needs a media server (SFU) — a known scaling limit, noted for a future version.

## How it works

```
 ┌────────────────────┐        WebRTC (voice + screen, peer-to-peer)
 │  Chrome extension  │◀──────────────────────────────────────────────┐
 │  (content.js)      │                                                │
 │  • symbol presence │        ┌────────────────────┐                  │
 │  • overlay UI      │        │   another friend   │──────────────────┘
 │  • WebRTC mesh     │        └────────────────────┘
 └─────────┬──────────┘
           │ signaling (offer/answer/ICE + presence) via service worker
           ▼
 ┌────────────────────┐
 │  signaling server  │   ws://localhost:8080  (rooms by share code)
 │  (server/server.js)│
 └────────────────────┘
```

Voice and screen never pass through the server — only signaling and presence do.
Topology is a WebRTC **mesh**, ideal for small friend groups (~2–6).

## Run it

### 1. Start the signaling server

```bash
cd server
npm install
npm start          # listens on ws://localhost:8080
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Open `https://www.tradingview.com/chart/` — the **TradingTalk** panel appears bottom-right

### 3. Test with a friend (or two browser profiles)

- One person clicks **New room**, then **Join**, and shares the room code
- Others paste the code and **Join**
- Allow the microphone prompt; you start **muted** — click **Unmute** to talk
- Switch charts and watch the symbol update next to each name
- Click **Share** to share a screen/tab; click a thumbnail to expand it
- Click **Share trades** (opt-in) to broadcast your open positions + entry/exit events

## Trade entry/exit detection

When you enable **Share trades**, the extension reads TradingView's **Account Manager**
(the bottom trading panel) every 2 seconds and broadcasts your open positions. It diffs
snapshots to emit **entry / exit / add / reduce** events, shown as badges next to your
name (▲ LONG / ▼ SHORT @ price) and in a live feed for everyone in the room.

**Requirements & limits — read this:**

- You must be trading *through* TradingView — **Paper Trading** (free, built-in, perfect
  for testing) or a **connected broker** — with the Account Manager panel present.
  No broker/paper account = nothing to detect.
- It's **opt-in and off by default.** Trades are sensitive; nothing is scraped or sent
  until you toggle it on (the choice is remembered).
- Detection works by matching **column-header text** ("Symbol", "Side", "Qty", "P&L"),
  not TradingView's hashed CSS classes — so it tolerates most UI updates. If TradingView
  renames a column or changes the panel structure, set `window.__tvSquadDebug = true`
  in the page console to see what the scraper detects, then adjust `HEADER_RE` in
  `content.js`.
- If the panel is closed it keeps the last known positions rather than firing false exits.

## v1 scope / known limits

- **One signaling server, run locally.** To use it with friends over the internet,
  host `server.js` somewhere and change `SERVER_URL` in `extension/background.js`
  (and add the host to `host_permissions` in `manifest.json`).
- **NAT traversal uses public STUN only.** Friends behind strict/symmetric NATs may
  fail to connect until a **TURN** server is added to `RTC_CONFIG` in `content.js`.
- **Trade detection needs a broker/paper account + the panel open** (see section above).
- **No persistent accounts / friend list.** "Friends" = whoever has the room code.
- Symbol detection relies on TradingView's DOM/URL; if TradingView changes its markup,
  update `detectSymbol()` in `content.js`.

## Files

| File | Purpose |
|------|---------|
| `extension/manifest.json` | MV3 manifest |
| `extension/content.js` | Presence detection, overlay UI, WebRTC mesh |
| `extension/background.js` | Service worker; signaling WebSocket bridge |
| `server/server.js` | Room + signaling + presence relay |
