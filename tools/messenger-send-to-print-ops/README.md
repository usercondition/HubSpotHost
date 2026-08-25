# Print Ops — Messenger scan (V1)

One-click bridge: open a Messenger thread (or the local mock) → scroll-load the full
selected conversation → send cleaned text into Print Ops Manual entry.

## Live install (after deploy)

1. Open Manual entry on Print Ops and use **Download the Chrome helper zip**, or:
   `https://print-orders-margin.pplx.app/port/5000/downloads/messenger-send-to-print-ops-v1.zip`
2. Unzip → Load unpacked the `messenger-send-to-print-ops` folder in `chrome://extensions` (Developer mode on).
3. Options: base URL should already be the Railway host; paste your owner access code → Save.
4. Open a real Messenger thread → **Send to Print Ops**.

## Test environment (local mock)

1. Run Print Ops locally with an owner intake code configured:

```bash
# .env must include PAID_ORDER_INTAKE_ACCESS_CODE_HASH (sha256 of your code)
npm run dev
```

2. Open the mock Messenger UI:

`http://127.0.0.1:5000/dev/mock-messenger`

(Only served in development, or when `MESSENGER_SCAN_TEST_UI=1`.)

3. Load the extension in Chrome:
   - `chrome://extensions` → Developer mode → **Load unpacked**
   - Choose `tools/messenger-send-to-print-ops`

4. Extension **Options**:
   - Base URL: `http://127.0.0.1:5000`
   - Access code: your owner unlock code
   - Save (grants host permission for that origin)

5. On the mock page, scroll is optional — click **Send to Print Ops** (FAB) or the
   toolbar icon. The extension auto-scrolls to load older bubbles, then opens
   `/paid-orders?bridge=…` with the thread ready to apply.

## Real Messenger

Same extension matches `messenger.com` / Facebook Messages. DOM selectors are
best-effort and may need updates when Meta restyles the UI. Prefer validating on
the mock page first.

## Security notes

- Create bridge requires the owner access code.
- Redeem is consume-once via an unguessable id (10-minute TTL). Raw text is not
  written to HubSpot; Manual entry still requires your confirmation to create.

## Files

| Path | Role |
|---|---|
| `content.js` | Full-thread scroll + extract + FAB |
| `background.js` | Bridge POST + open Manual tab |
| `options.html` | Base URL + access code |
| `test/mock-messenger.html` | Local lazy-load conversation |
