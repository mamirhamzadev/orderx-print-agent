# OrderX Print Agent

Local Electron service on the POS PC. POS Web talks to this app on **127.0.0.1:17888**; the agent later sends ESC/POS to a thermal printer. The agent never talks to the OrderX backend.

## Current

- Electron window + system tray (Open / Quit)
- Starts with Windows (tray). If already paired, the local service starts by itself
- Local pairing starts the service; unpair stops it completely
- Authenticated WebSocket: `agent.hello` on connect, heartbeat every 10s, `agent.status` on change

## Run in development

```bash
cd D:\OrderX\pos-print-agent
npm install
npm start
```

Headless service only (no window):

```bash
npm run service
```

## Local HTTP

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | `{ running, version, paired, pendingPairing }` |
| POST | `/pair/confirm` | none | Body `{ code, shopId }` → `{ token, shopId, port }` |
| GET | `/status` | Bearer | Snapshot after pairing |
| POST | `/unpair` | Bearer | Clear the stored token |

WebSocket: `ws://127.0.0.1:17888/?token=…&shopId=…` (token required; shop must match). POS restores this after login when a pairing token is in `localStorage`.

## Pairing

1. In POS Web go to **Settings → Printers** and copy the code
2. Type it in this app and click **Confirm**
3. POS Web polls `/pair/confirm` and stores the token in `localStorage`

Codes expire after 10 minutes and are one-time.

## Tray

Closing the window hides the agent in the tray. Use **Quit** on the tray menu to exit.

On Windows the agent registers itself to start at login (hidden in the tray). If it was already paired, the print service comes up with no extra click. Open POS Web and it will find the agent.
