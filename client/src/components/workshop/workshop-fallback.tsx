import { shopDateLabel, shipByCalendarDate } from "@shared/ship-by";
import { orderTitle } from "@/lib/order-title";
import { WORKSHOP_STATIONS, groupOrdersByStation } from "@/lib/workshop-stations";
import type { ProductionQueueItem } from "@shared/schema";
import type { WorkshopHover } from "@/lib/workshop-types";

export function WorkshopFallback({
  orders,
  selectedDealId,
  onHover,
  onSelect,
}: {
  orders: ProductionQueueItem[];
  selectedDealId: string | null;
  onHover: (hover: WorkshopHover | null) => void;
  onSelect: (dealId: string) => void;
}) {
  const today = shipByCalendarDate();
  const grouped = groupOrdersByStation(orders);
  return (
    <div className="workshop-fallback" data-testid="panel-workshop-fallback">
      <p className="workshop-fallback-note">3D view needs WebGL. Station map is still live and read-only.</p>
      <div className="workshop-fallback-grid">
        {WORKSHOP_STATIONS.map((station) => (
          <section key={station.id} className="workshop-fallback-station" data-station={station.id}>
            <h2>
              {station.label}
              <span className="numeric">{grouped[station.id].length}</span>
            </h2>
            <ul>
              {grouped[station.id].length === 0 ? <li className="text-muted-foreground">Empty</li> : null}
              {grouped[station.id].map((order) => {
                const name = orderTitle(order.dealName, order.contactName);
                const shipBy = shopDateLabel({
                  date: order.shipBy,
                  today,
                  source: order.shipBySource === "override" ? "override" : "derived",
                  tentative: order.tentative,
                });
                return (
                  <li key={order.dealId}>
                    <button
                      type="button"
                      data-selected={selectedDealId === order.dealId ? "true" : "false"}
                      onMouseEnter={() =>
                        onHover({ dealId: order.dealId, name, shipBy, station: station.id })
                      }
                      onMouseLeave={() => onHover(null)}
                      onFocus={() => onHover({ dealId: order.dealId, name, shipBy, station: station.id })}
                      onBlur={() => onHover(null)}
                      onClick={() => onSelect(order.dealId)}
                    >
                      <span className="truncate">{name}</span>
                      <span className="truncate text-[hsl(var(--text-3))]">{shipBy}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
