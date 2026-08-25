# Print Ops — Marketplace secretary (Chrome helper)

One button → scan recent Marketplace / Messenger chats → secretary brief in Print Ops:
who to reply to, who’s waiting on payment, who’s ready to book, what to do next.

## Live install

1. After deploy, download:
   `https://print-orders-margin.pplx.app/port/5000/downloads/messenger-send-to-print-ops-v1.zip`
   (also linked from **Brief** and **Manual** in the app)
2. Unzip → Chrome `chrome://extensions` → Developer mode → **Load unpacked**
3. Options: Railway URL (prefilled) + owner access code → Save
4. Open Messenger (or local mock) → extension popup → **Run inbox brief**

## Local mock

```bash
npm run dev
```

Open `http://127.0.0.1:5000/dev/mock-messenger` (multi-thread Marketplace inbox).
Click **Inbox brief**. Opens `/#/marketplace-brief` with Do first / Then / Waiting.

## What the secretary does

| Signal | Suggested stance |
|---|---|
| Buyer last / unread | Your turn — reply (+ draft) |
| Paid, no address | Ask for shipping details |
| Paid + address | Ready to book → Manual |
| You last wrote | Waiting on buyer / stale nudge |
| Shipped / complete | Done |

No auto-send to buyers. No HubSpot writes from the brief itself.

## Files

| Path | Role |
|---|---|
| `popup.html` | **Run inbox brief** + single-thread assist |
| `content.js` | Inbox list scan + full-thread extract |
| `background.js` | POST brief / Manual bridge |
| `test/mock-messenger.html` | Local multi-thread inbox |
