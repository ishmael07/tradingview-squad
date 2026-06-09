# Going live — trade with your friends

The extension talks to a small **signaling server**. On your machine that's
`localhost`, which only you can reach. To use it with friends you need that server
on a public **`wss://`** URL (TradingView is HTTPS, so an insecure `ws://` to a
remote host is blocked by the browser).

Pick **one** path below, then do "Share the extension" at the bottom.

---

## Path A — Fastest, for testing today (tunnel)

Keep the server running locally and expose it with a secure tunnel. ~2 minutes.

1. Start the server (leave it running):
   ```bash
   cd ~/tradingview-squad/server && npm install && npm start
   ```
2. In another terminal, start a Cloudflare tunnel (no account needed):
   ```bash
   brew install cloudflared          # once
   cloudflared tunnel --url http://localhost:8080
   ```
   It prints a URL like `https://random-words.trycloudflare.com`.
3. Your server URL is that with `https` → `wss`:
   `wss://random-words.trycloudflare.com`
4. In the extension: **⚙️ Settings → Server URL**, paste that `wss://…` URL.
   Tell your friend to paste the **exact same** URL.

> Tradeoffs: your computer must stay on, and the free tunnel URL changes each time
> you restart `cloudflared`. Great for a session; not permanent.

(ngrok works too: `ngrok http 8080` → use the `https` URL as `wss`.)

---

## Path B — Permanent, always-on (Render, free tier)

1. Push this folder to a GitHub repo.
2. Go to https://render.com → **New → Blueprint**, pick your repo. It reads
   `render.yaml` and creates the service automatically.
   (Or **New → Web Service**, root dir `server`, build `npm install`, start `node server.js`.)
3. After deploy you get `https://your-app.onrender.com`. Your server URL is
   `wss://your-app.onrender.com`.
4. Put that in **⚙️ Settings → Server URL** (and have friends do the same), **or**
   bake it in as the default so nobody has to: edit `extension/content.js`,
   set `const DEFAULT_SERVER = 'wss://your-app.onrender.com';`

> Render free tier sleeps after inactivity and wakes on the next request (a few
> seconds' delay on first connect). Fine for a friend group.

---

## Share the extension with friends

Chrome Web Store review takes days, so for now distribute the folder directly:

1. Zip the **`extension/`** folder.
2. Send it to your friend. They:
   - unzip it,
   - open `chrome://extensions`, enable **Developer mode**,
   - click **Load unpacked**, select the `extension/` folder.
3. Everyone opens `https://www.tradingview.com/chart/`, sets the **same Server URL**
   in ⚙️ Settings (skip if you baked it in), and joins the **same room code** (or the
   same **Public** ticker room). Allow the mic prompt → you're trading together.

When you're ready for one-click installs + auto-updates, publish to the Chrome Web
Store ($5 one-time developer account); the same `extension/` folder is the upload.

---

## Connectivity notes

- WebRTC voice/video is **peer-to-peer**; only signaling crosses the server.
- STUN + free **TURN** (OpenRelay) are already configured, so two home networks
  should connect. For heavy/production use, run your own TURN (e.g. coturn) and
  update `RTC_CONFIG` in `extension/content.js`.
- Rooms use a **mesh** — ideal for small groups (~2–6). Big public rooms need a
  media server (SFU); that's the next scaling step.
