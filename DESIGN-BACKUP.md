# UI design backup

**Fallback branch:** `cursor/backup-floor-board-ui-693d`

This branch freezes the Floor Board chrome (Run → Take → Keep, cobalt/zinc cutting-mat)
as it existed on `main` at commit `800c74b` before the Railway-inspired Workspace redesign.

## Restore

```bash
git checkout main
git checkout cursor/backup-floor-board-ui-693d -- client/src/components/shell.tsx client/src/index.css client/index.html client/public/favicon.svg client/src/pages/dashboard.tsx client/src/pages/setup.tsx
# review, commit, merge to main
```

Or reset `main` to that branch if you want a full rollback of chrome-only files from that snapshot.
