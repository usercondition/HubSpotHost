# Print Ops + Stack pre-flight checklist (living)
Last updated: Fri Sep 25, 2026. Run every item before a fix counts as done.

## 1. Layout and alignment (check at 1024px desktop and 390px phone)
- [ ] Every open Stack row (normal, bundle, off-book) sits on one shared column grid: number, name/client, status, blocker, date, amount, actions. Status, blocker, date and amount columns start at the same x on every open row. Out the door is a separate collapsed list (name, Shipped or Picked up, amount, Undo) and is not on that grid.
- [ ] Bundle rows use the same grid as single rows. The member count ("▸ 3") sits inside the name column, not in a column of its own.
- [ ] Row numbers run 1 to N straight down the list with no repeats or gaps, both bundled and unbundled.
- [ ] Long status or blocker text truncates with an ellipsis inside its column and never pushes the next column.
- [ ] Section rows ("This week", "Stretch", and the Out the door header) right-align their totals on that line. They are not a cell in the amount column.
- [ ] On an open row, extra actions sit in the overflow (…) menu, and the row keeps up, down, and top. Shipping rows have no extra actions and no … menu. Bundle, off-book, and pickup put Done, Picked up, or Ungroup in that menu. Out the door uses an inline Undo button.
- [ ] The Bundle… button appears only when 2 or more orders are selected. Otherwise the hint "Select 2+ to bundle" shows from the sm breakpoint up. It is hidden on the phone.
- [ ] Phone at 390px: the Floor action row stays on one line (Queue, Prints, Intake). The phone tab row is the Run group and scrolls sideways. Orders stays off that row (it is under More). Stack header actions may wrap.
- [ ] Queue lanes size to their content, with no tall empty boxes.
- [ ] Shop pages (Floor, Stack, Queue, Prints, Labels) show no developer text (deep-link hints, route names, raw ids). Setup lists routes for the owner.
- [ ] Floor has no ship calendar. Queue shows only Next print and In production.

## 2. Behavior
- [ ] Attaching a label marks the Stack row done and moves it to Out the door, even when HubSpot writes are off.
- [ ] Money counts once. A done order leaves open cash and shows in Out the door. Weekly goal = open + Out the door.
- [ ] A reprinted label keeps the first completion date, saves the new tracking and ShipEngine label id, carrier and service, and sends no second shipped email or Marketplace note.
- [ ] Shipping bundle: marking the bundle done marks every member done. A partial shipping bundle with at least one shipped member shows "X of N shipped". Before that it shows "ready/total ready".
- [ ] A label on a pickup-bundle member shows a warning.
- [ ] "Picked up" moves the linked HubSpot deal(s) to Completed when writes are allowed. Dry run and ALLOW_HUBSPOT_WRITES still apply. Off-book orders never write to HubSpot.
- [ ] Undo on an Out the door row clears only the local done mark. The HubSpot stage is not reverted, and the row says so.
- [ ] The Stack refreshes on its own after a label attaches.
- [ ] Drawer: same-client orders that were auto-added have checkboxes so they can be unticked.
- [ ] Ready and blocked orders open on the Stack from Floor work links and from old Queue deep links, which redirect. Ask Ops ship answers link to the Stack. Cost shortcuts, the default attention step ("Open in Queue"), and some Ask Ops answers still open Queue and still say Queue.
- [ ] The Floor "needs you" count equals the Needs you list. The bell badge is the attention count, plus one when HubSpot sync has issues. Those counts are not required to match.

## 3. Sync and security
- [ ] /api/health returns status ok, mode live-write, allowHubspotWrites true, dryRun false, and durable storage.
- [ ] Print Ops and HubSpot agree. The hubspotSync block has a recent lastCheckedAt (under 15 minutes), failedWrites 0, missingInOps 0, orphans 0, doneStillOpen 0 and closedNotDone 0. Any other count is explained before shipping.
- [ ] Auto-fill writes only blank HubSpot fields. It never overwrites a non-blank value. Conflicts are listed in sync health, not auto-fixed.
- [ ] Blank cost fill (seedPrintDealCosts) writes only blank HubSpot cost fields: labor $0, packaging $0, material from the plate estimate when one exists, and postage only from a real label amount. A non-blank HubSpot value, including $0, is left alone. This is not limited to free USPS.
- [ ] The owner-only Stack stays locked. /api/priority-stack, /api/sync-health, and /api/production-queue return 401 without the owner code. There is no public /api/queue.
- [ ] /api/production-queue still returns ready and blocked orders, because digests, calendar sync and Ask Ops read it.

## 4. Data
- [ ] Unpriced off-book orders show "—" for the amount and carry the "off-book" tag. The Floor cash line adds the contact name or title (for example "$274.95 + Darell"), not a phrase like "+1 off-book, no amount". totals.offBookUnpriced is the count of those committed rows.
- [ ] Stack auto order sorts by target date (earlier, including overdue, first), then readiness (ship-ready, then post-process, then in production, then blocked, then next print), then amount (higher first), then priorityScore (higher first), then name. Manual order sticks until "Reset to auto". A new unranked row is inserted before the first manual row with a strictly later target date.
- [ ] Out the door rows add up exactly to the header's Out the door total.
- [ ] Dates show as "Sep 27 · set" (override or local), "· plan" (derived), or "· unset". Past dates are "Overdue Sep 27". "Due today" is highlighted. A tentative date is prefixed with "~". All dates are Pacific.
- [ ] Screenshots and demos use sample data and say so. No invented live numbers.

## 5. Ship process
- [ ] Branch off the latest main. Local tests all pass (the repo has no GitHub CI).
- [ ] Before and after screenshots of each touched page, desktop and phone.
- [ ] After merge, the Railway deploy shows SUCCESS and the health check passes live.
- [ ] Nothing reaches a customer without a draft and Miguel's OK.
- [ ] Miguel gets a short ping on PR open, merge and live.

## Gaps to decide
1. HubSpot webhook: Print Ops accepts them, but none have arrived. Decide whether to set up the HubSpot subscription so deal changes flow in live.
2. Conflict winner: when both sides have different non-blank values, which side wins, and who fixes it?
3. "Closeness to done": parts done out of total, plates, or stage? Also the tie-break after amount.
4. Undo and HubSpot: should Undo ever roll the deal stage back, or stay local only?
5. Label voiding: saved ShipEngine ids exist, but there's no void flow. What should voiding do to Out the door and money?
6. Off-book money: should off-book orders ever count toward the weekly goal if an amount is entered?
7. Column widths and truncation: fixed widths per column, and a minimum width before switching to the phone layout.
8. Cost links still point to Queue. Move them to the Stack or keep them?
9. priorityScore is unchanged while the Stack uses its own sort. Should they be merged into one ranking?
10. Partial pickup bundles: what shows when some members are picked up and others aren't?
