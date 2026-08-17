# Print Ops Marketplace Scan (Chrome helper)

User-triggered Chrome extension for your print ops app. It reads the **visible** Facebook Marketplace / Messenger thread DOM, keeps buyer/you labels, and posts them to:

- `POST /api/conversation-scan` — stage + nudges + intake suggestions
- `GET /api/conversation-watchlist` — buried “waiting on you” reminders
- `POST /api/conversation-watchlist/inbox` — optional inbox list snapshot

It does **not** reverse-engineer Marketplace private APIs or run in the background.

## Install (unpacked, for testing)

1. Start the Print Ops app locally (`npm run dev`) or point at your Railway URL.
2. Chrome → **Extensions** → enable **Developer mode**.
3. **Load unpacked** → select this folder: `chrome-extension/marketplace-scan`.
4. Open the extension popup:
   - App base URL: `http://localhost:5000` (or your public HTTPS origin)
   - Owner access code: same code as Command center unlock
5. Open a Marketplace conversation on facebook.com.
6. Click **Scan open thread** → review the labeled transcript → **Analyze + nudge**.

## Testing without Facebook

Paste a labeled transcript in the popup:

```text
[buyer] Hi, still available?
[you] Yes — $45 shipped
[buyer] Paid via Venmo just now
```

Then **Analyze + nudge**. With “Save to watchlist” checked, **Load reminders** should show the buried follow-up.

## Notes

- Meta can change Messenger markup; if roles look wrong, edit the transcript before sending.
- Long threads: scroll up so older bubbles are in the DOM before scanning.
- Watchlist stores summaries only (name, stage, last preview) — not the full chat.
- Telegram morning digest includes a **MARKETPLACE FOLLOW-UPS** section when chats are waiting on you.
