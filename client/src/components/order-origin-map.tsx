import { useEffect, useMemo, useRef, useState } from "react";
import { geoAlbersUsa, geoNaturalEarth1, geoPath, type GeoPermissibleObjects } from "d3-geo";
import { feature } from "topojson-client";
import statesAtlas from "us-atlas/states-10m.json";
import worldAtlas from "world-atlas/countries-110m.json";
import { averageOrder, LOCAL_PICKUP, type OrderOrigins } from "@shared/order-origins";
import { cn } from "@/lib/utils";

const FIPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
  "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
  "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
  "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
};

type Shape = { id: string; name: string; d: string };
type Focus = { kind: "state" | "place" | "pickup" | "country"; id: string } | null;

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function summary(orders: number, revenue: number, priced: number): string {
  const avg = averageOrder({ orders, revenue, priced });
  const orderLabel = `${orders} order${orders === 1 ? "" : "s"}`;
  return avg == null ? `${orderLabel} · ${money(revenue)}` : `${orderLabel} · ${money(revenue)} · avg ${money(avg)}`;
}

function shade(value: number, max: number, revenue: boolean): string {
  if (value <= 0 || max <= 0) return "hsl(240 4% 13%)";
  const t = Math.sqrt(value / max);
  return revenue ? `hsl(158 48% ${18 + t * 30}%)` : `hsl(186 72% ${16 + t * 32}%)`;
}

function shapes(atlas: { objects: Record<string, unknown> }, objectName: string, width: number, height: number, world: boolean): { shapes: Shape[]; project: (lon: number, lat: number) => [number, number] | null } {
  const collection = feature(atlas as never, atlas.objects[objectName] as never) as GeoPermissibleObjects & {
    features: Array<{ id?: string | number; properties?: { name?: string } }>;
  };
  const projection = (world ? geoNaturalEarth1() : geoAlbersUsa()).fitSize([width, height], collection);
  const path = geoPath(projection);
  const drawn: Shape[] = [];
  for (const item of collection.features) {
    const d = path(item as GeoPermissibleObjects);
    if (!d) continue;
    const id = world ? String(item.properties?.name ?? "") : FIPS[String(item.id ?? "").padStart(2, "0")] ?? "";
    if (!id) continue;
    drawn.push({ id, name: item.properties?.name || id, d });
  }
  return {
    shapes: drawn,
    project: (lon, lat) => {
      const point = projection([lon, lat]);
      return point ? [point[0], point[1]] : null;
    },
  };
}

export function OrderOriginMap({ origins }: { origins: OrderOrigins }) {
  const [world, setWorld] = useState(false);
  const [byRevenue, setByRevenue] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  const [locked, setLocked] = useState<Focus>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; k: number } | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const moved = useRef(false);
  useEffect(() => {
    const clear = () => { pointers.current.clear(); pinch.current = null; drag.current = null; };
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    return () => { window.removeEventListener("pointerup", clear); window.removeEventListener("pointercancel", clear); };
  }, []);

  const map = useMemo(
    () => (world ? shapes(worldAtlas as never, "countries", 960, 480, true) : shapes(statesAtlas as never, "states", 960, 500, false)),
    [world],
  );

  const valueOf = (orders: number, revenue: number) => (byRevenue ? revenue : orders);
  const stateValue = new Map(origins.states.map((row) => [row.code, row]));
  const countryValue = new Map(origins.countries.filter((row) => row.plotName).map((row) => [row.plotName as string, row]));
  if (world) {
    const united = origins.states.reduce(
      (sum, row) => ({ orders: sum.orders + row.orders, revenue: Math.round((sum.revenue + row.revenue) * 100) / 100, priced: sum.priced + row.priced }),
      { orders: 0, revenue: 0, priced: 0 },
    );
    if (united.orders > 0) countryValue.set("United States of America", { name: "United States of America", plotName: "United States of America", ...united });
  }
  const max = Math.max(
    1,
    ...map.shapes.map((shape) => {
      const row = world ? countryValue.get(shape.name) : stateValue.get(shape.id);
      return row ? valueOf(row.orders, row.revenue) : 0;
    }),
  );
  const placeMax = Math.max(1, ...origins.places.map((place) => place.orders));
  const active = focus ?? locked;

  function detail(): string {
    if (!active) return "Tap a state or city for orders, revenue, and the average order.";
    if (active.kind === "pickup") return `Local pickup · San Diego · ${summary(origins.pickup.orders, origins.pickup.revenue, origins.pickup.priced)}`;
    if (active.kind === "place") {
      const place = origins.places.find((row) => row.id === active.id);
      return place ? `${place.label} · ${summary(place.orders, place.revenue, place.priced)}` : "";
    }
    if (active.kind === "country") {
      const country = origins.countries.find((row) => row.name === active.id || row.plotName === active.id);
      return country ? `${country.name} · ${summary(country.orders, country.revenue, country.priced)}` : active.id;
    }
    const state = stateValue.get(active.id);
    const name = map.shapes.find((shape) => shape.id === active.id)?.name ?? active.id;
    return state ? `${name} · ${summary(state.orders, state.revenue, state.priced)}` : `${name} · 0 orders`;
  }

  const listed = origins.orders.filter((order) => {
    if (selected === "pickup") return order.pickup;
    if (selected === "unknown") return !order.pickup && !order.state && !order.country;
    if (selected) return order.state === selected && !order.pickup;
    return false;
  });

  function resetView() {
    setView({ x: 0, y: 0, k: 1 });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Shade the map by">
          <button type="button" className={cn("rounded px-2.5 py-1 text-xs", !byRevenue && "bg-primary text-primary-foreground")} onClick={() => setByRevenue(false)} data-testid="button-origin-count">
            Orders
          </button>
          <button type="button" className={cn("rounded px-2.5 py-1 text-xs", byRevenue && "bg-primary text-primary-foreground")} onClick={() => setByRevenue(true)} data-testid="button-origin-revenue">
            Revenue
          </button>
        </div>
        {origins.outsideUs ? (
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Map">
            <button type="button" className={cn("rounded px-2.5 py-1 text-xs", !world && "bg-secondary")} onClick={() => { setWorld(false); resetView(); }} data-testid="button-origin-us">
              United States
            </button>
            <button type="button" className={cn("rounded px-2.5 py-1 text-xs", world && "bg-secondary")} onClick={() => { setWorld(true); resetView(); }} data-testid="button-origin-world">
              World
            </button>
          </div>
        ) : null}
        {view.k !== 1 || view.x !== 0 || view.y !== 0 ? (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs text-muted-foreground" aria-label="Map actions">…</summary>
            <button type="button" className="absolute right-0 z-10 whitespace-nowrap rounded-md border border-border bg-background px-2 py-1 text-xs" onClick={resetView}>Reset view</button>
          </details>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-[hsl(240_4%_5%)]" data-testid="stats-origin-frame">
        <svg
          data-testid="stats-origin-svg"
          viewBox="0 0 960 500"
          className="block h-auto w-full"
          role="img"
          aria-label="Where orders come from"
          onPointerDown={(event) => {
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            moved.current = false;
            if (pointers.current.size === 2) {
              const [a, b] = Array.from(pointers.current.values());
              pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: view.k };
            } else {
              drag.current = { x: event.clientX, y: event.clientY, panX: view.x, panY: view.y };
            }
          }}
          onPointerMove={(event) => {
            const current = pointers.current.get(event.pointerId);
            if (!current) return;
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pointers.current.size >= 2 && pinch.current) {
              const [a, b] = Array.from(pointers.current.values());
              const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
              const next = Math.min(6, Math.max(1, pinch.current.k * (distance / pinch.current.distance)));
              setView((item) => ({ ...item, k: next }));
              return;
            }
            if (!drag.current) return;
            const dx = event.clientX - drag.current.x;
            const dy = event.clientY - drag.current.y;
            if (Math.hypot(dx, dy) > 5) moved.current = true;
            if (moved.current) setView({ x: drag.current.panX + dx, y: drag.current.panY + dy, k: view.k });
          }}
          onPointerUp={(event) => {
            pointers.current.delete(event.pointerId);
            if (pointers.current.size < 2) pinch.current = null;
            drag.current = null;
          }}
          onPointerCancel={() => { pointers.current.clear(); pinch.current = null; drag.current = null; }}
          onLostPointerCapture={() => { pointers.current.clear(); pinch.current = null; drag.current = null; }}
          onPointerLeave={() => setFocus(null)}
        >
          <rect width="960" height="500" fill="hsl(240 4% 5%)" onClick={() => { setSelected(null); setLocked(null); }} />
          <g transform={`translate(${480 + view.x} ${250 + view.y}) scale(${view.k}) translate(-480 -250)`}>
            {map.shapes.map((shape) => {
              const row = world ? countryValue.get(shape.name) : stateValue.get(shape.id);
              const value = row ? valueOf(row.orders, row.revenue) : 0;
              const hot = active?.id === (world ? shape.name : shape.id) || selected === shape.id;
              return (
                <path
                  key={shape.id}
                  data-testid={`origin-state-${shape.id}`}
                  d={shape.d}
                  fill={shade(value, max, byRevenue)}
                  stroke={hot ? "hsl(186 72% 72%)" : "hsl(240 5% 22%)"}
                  strokeWidth={hot ? 1.4 : 0.6}
                  style={{ transition: "fill 180ms ease, stroke 180ms ease" }}
                  onMouseEnter={() => setFocus({ kind: world ? "country" : "state", id: world ? shape.name : shape.id })}
                  onMouseLeave={() => setFocus(null)}
                  onClick={(event) => {
                    if (moved.current) return;
                    event.stopPropagation();
                    const id = world ? shape.name : shape.id;
                    setSelected((current) => (current === id ? null : id));
                    setLocked({ kind: world ? "country" : "state", id });
                  }}
                >
                  <title>{shape.name}</title>
                </path>
              );
            })}
            {origins.places.map((place) => {
              const point = map.project(place.lon, place.lat);
              if (!point) return null;
              const radius = 4 + Math.sqrt(place.orders / placeMax) * 11;
              return (
                <g key={place.id} onMouseEnter={() => setFocus({ kind: "place", id: place.id })} onMouseLeave={() => setFocus(null)}>
                  <circle cx={point[0]} cy={point[1]} r={radius + 8} fill="transparent" onClick={(event) => { event.stopPropagation(); setLocked({ kind: "place", id: place.id }); setSelected(place.state); }} />
                  <circle
                    data-testid={`origin-dot-${place.id}`}
                    cx={point[0]}
                    cy={point[1]}
                    r={radius}
                    fill="hsl(186 72% 62% / 0.9)"
                    stroke="hsl(240 4% 6%)"
                    strokeWidth={1}
                    style={{ transition: "r 180ms ease" }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setLocked({ kind: "place", id: place.id });
                      setSelected(place.state);
                    }}
                  />
                </g>
              );
            })}
            {origins.pickup.orders > 0 ? (() => {
              const point = map.project(LOCAL_PICKUP.lon, LOCAL_PICKUP.lat);
              if (!point) return null;
              return (
                <g onMouseEnter={() => setFocus({ kind: "pickup", id: "pickup" })} onMouseLeave={() => setFocus(null)}>
                  <circle cx={point[0]} cy={point[1]} r={14} fill="transparent" />
                  <circle cx={point[0]} cy={point[1]} r={6} fill="none" stroke="hsl(158 50% 58%)" strokeWidth={2} />
                  <circle
                    cx={point[0]}
                    cy={point[1]}
                    r={2.5}
                    fill="hsl(158 50% 58%)"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelected("pickup");
                      setLocked({ kind: "pickup", id: "pickup" });
                    }}
                  />
                </g>
              );
            })() : null}
          </g>
        </svg>
      </div>

      <div className="mt-3 space-y-2" data-testid="stats-origin-legend">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-16 rounded-full" style={{ background: byRevenue ? "linear-gradient(90deg, hsl(158 48% 18%), hsl(158 48% 48%))" : "linear-gradient(90deg, hsl(186 72% 16%), hsl(186 72% 48%))" }} />
            {byRevenue ? "Less revenue" : "Fewer orders"} to more
          </span>
          {origins.pickup.orders > 0 ? (
            <button type="button" className="inline-flex items-center gap-1.5" onClick={() => setSelected((current) => (current === "pickup" ? null : "pickup"))}>
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[hsl(158_50%_58%)]" />
              Local pickup · San Diego <span className="numeric inline-block w-8 text-right">({origins.pickup.orders})</span>
            </button>
          ) : null}
          <button type="button" className="inline-flex items-center gap-1 text-left" onClick={() => setSelected((current) => (current === "unknown" ? null : "unknown"))} data-testid="button-origin-unknown">
            Unknown location <span className="numeric inline-block w-8 text-right">({origins.unknown})</span>
          </button>
        </div>
        {origins.incomplete ? <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="stats-origin-busy">{origins.busy ? "HubSpot busy, map may be incomplete." : "Map data incomplete, retry."}</p> : null}
        <p className="text-sm" data-testid="stats-origin-detail">{detail()}</p>
        {selected ? (
          <ul className="divide-y divide-border/70" data-testid="stats-origin-orders">
            {listed.length === 0 ? <li className="py-1 text-sm text-muted-foreground">No orders in this selection.</li> : null}
          </ul>
        ) : null}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">ZIP centroids: GeoNames, CC BY 4.0.</p>
    </div>
  );
}
