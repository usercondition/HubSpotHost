import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { decodeCtbRle } from "@/lib/ctb-layer";
import type { PlateFileRecord } from "@shared/plate-files";

const FETCH_WAIT_MS = 160;

function layerMaxEdge(): number {
  if (typeof window === "undefined") return 960;
  return window.matchMedia("(max-width: 767px)").matches ? 480 : 960;
}

function layerLabel(index: number, count: number): string {
  const width = String(Math.max(count, 1)).length;
  const current = String(index + 1).padStart(width, "\u2007");
  return `${current} / ${count}`;
}

export function PlateLayerView({
  file,
  headers,
}: {
  file: PlateFileRecord;
  headers: Record<string, string>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef(new Map<number, Uint8Array>());
  const ticketRef = useRef(0);
  const [count, setCount] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError("");
    setCount(0);
    setIndex(0);
    setShown(0);
    cacheRef.current.clear();
    void apiRequest("GET", `/api/plate-files/${encodeURIComponent(file.driveFileId)}/layers`, undefined, { headers })
      .then((response) => response.json() as Promise<{ layerCount?: number; width?: number; height?: number }>)
      .then((body) => {
        if (cancelled) return;
        const layerCount = body.layerCount ?? 0;
        if (layerCount < 1 || !body.width || !body.height) {
          setError("This plate has no layer preview.");
          return;
        }
        setCount(layerCount);
        setSize({ width: body.width, height: body.height });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("This plate has no layer preview.");
      });
    return () => {
      cancelled = true;
    };
  }, [file.driveFileId, headers]);

  useEffect(() => {
    const timer = window.setTimeout(() => setShown(index), FETCH_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [index]);

  useEffect(() => {
    if (!ready || count < 1 || size.width < 1) return;
    const ticket = ticketRef.current + 1;
    ticketRef.current = ticket;
    const paint = (bytes: Uint8Array) => {
      const canvas = canvasRef.current;
      if (!canvas || ticket !== ticketRef.current) return;
      const decoded = decodeCtbRle(bytes, size.width, size.height, layerMaxEdge());
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.putImageData(new ImageData(decoded.rgba, decoded.width, decoded.height), 0, 0);
    };
    const cached = cacheRef.current.get(shown);
    if (cached) {
      paint(cached);
      return;
    }
    let cancelled = false;
    void apiRequest(
      "GET",
      `/api/plate-files/${encodeURIComponent(file.driveFileId)}/layers/${shown}`,
      undefined,
      { headers },
    )
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        if (cancelled || ticket !== ticketRef.current) return;
        const bytes = new Uint8Array(buffer);
        const cache = cacheRef.current;
        if (cache.size > 12) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(shown, bytes);
        paint(bytes);
      })
      .catch(() => {
        if (!cancelled && ticket === ticketRef.current) setError("This plate has no layer preview.");
      });
    return () => {
      cancelled = true;
    };
  }, [ready, count, size.width, size.height, shown, file.driveFileId, headers]);

  const step = (delta: number) => {
    setIndex((current) => {
      const next = Math.min(count - 1, Math.max(0, current + delta));
      setShown(next);
      return next;
    });
  };

  useEffect(() => {
    if (!ready) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }
      event.preventDefault();
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      step(delta);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, count]);

  if (error) {
    return (
      <p className="mb-3 text-sm text-muted-foreground" data-testid="text-layer-missing">
        {error}
      </p>
    );
  }

  return (
    <div className="mb-3 grid gap-2" data-testid="plate-layer-scan">
      <div className="grid min-h-56 place-items-center overflow-hidden rounded-md bg-black">
        <canvas ref={canvasRef} className="max-h-72 max-w-full [image-rendering:pixelated]" data-testid="canvas-plate-layer" />
      </div>
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto_2rem] items-center gap-1.5">
        <button
          type="button"
          className="h-8 rounded-md text-xl leading-none text-foreground disabled:opacity-40"
          aria-label="Previous layer"
          data-testid="button-layer-prev"
          disabled={!ready || index <= 0}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <input
          type="range"
          className="min-w-0"
          min={0}
          max={Math.max(0, count - 1)}
          value={ready ? index : 0}
          disabled={!ready}
          aria-label="Layer"
          data-testid="input-layer-slider"
          onChange={(event) => setIndex(Number(event.target.value))}
        />
        <span className="min-w-[7.5rem] text-right font-mono text-sm tabular-nums" data-testid="text-layer-index">
          {ready ? layerLabel(shown, count) : "—"}
        </span>
        <button
          type="button"
          className="h-8 rounded-md text-xl leading-none text-foreground disabled:opacity-40"
          aria-label="Next layer"
          data-testid="button-layer-next"
          disabled={!ready || index >= count - 1}
          onClick={() => step(1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}
