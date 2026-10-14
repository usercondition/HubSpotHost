#!/usr/bin/env python3
"""
Mac -> Print Ops inbox sync (stdlib only). Run by launchd every few minutes.

Pushes ~/.hermes/data/inbox/marketplace.json to POST /api/inbox/cards when it
changes, then pulls owner reply edits into
~/.hermes/data/inbox/print-ops-edits.json for Hermes to pick up.

Config (never commit the token):
  PRINT_OPS_URL           default https://hubspothost-production.up.railway.app
  PRINT_OPS_INBOX_TOKEN   or the file ~/.hermes/secrets/print-ops-inbox-token (chmod 600)
"""
import hashlib, json, os, sys, urllib.request
from pathlib import Path

HOME = Path.home()
INBOX = HOME / ".hermes/data/inbox/marketplace.json"
EDITS = HOME / ".hermes/data/inbox/print-ops-edits.json"
STATE = HOME / ".hermes/data/inbox/.print-ops-sync-state.json"
BASE = os.environ.get("PRINT_OPS_URL", "https://hubspothost-production.up.railway.app").rstrip("/")
DROP = {"thread", "history"}  # Print Ops only needs `recent`; keeps the push small.


def token() -> str:
    t = os.environ.get("PRINT_OPS_INBOX_TOKEN", "").strip()
    f = HOME / ".hermes/secrets/print-ops-inbox-token"
    if not t and f.exists():
        t = f.read_text().strip()
    if not t:
        sys.exit("no PRINT_OPS_INBOX_TOKEN")
    return t


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={
        "Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def main():
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    raw = json.loads(INBOX.read_text())
    threads = raw.get("threads", {})
    items = threads.values() if isinstance(threads, dict) else threads
    slim = {"version": raw.get("version"), "updated_at": raw.get("updated_at"),
            "threads": [{k: v for k, v in t.items() if k not in DROP} for t in items]}
    digest = hashlib.sha256(json.dumps(slim, sort_keys=True).encode()).hexdigest()
    if digest != state.get("hash"):
        print("push", call("POST", "/api/inbox/cards", slim))
        state["hash"] = digest
    since = state.get("edits_since")
    q = "/api/inbox/edits" + (f"?since={urllib.parse.quote(since)}" if since else "")
    res = call("GET", q)
    if res.get("edits"):
        current = json.loads(EDITS.read_text()) if EDITS.exists() else {}
        for e in res["edits"]:
            current[e["cardId"]] = e
            state["edits_since"] = e["editedAt"]
        tmp = EDITS.with_suffix(".tmp")
        tmp.write_text(json.dumps(current, indent=1))
        tmp.replace(EDITS)
        print("edits", len(res["edits"]))
    STATE.write_text(json.dumps(state))


if __name__ == "__main__":
    import urllib.parse  # noqa: E402
    main()
