import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, ExternalLink, FileUp, Loader2, RotateCcw, Save, Search, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel } from "@/components/primitives";
import { MESH_FILE_ACCEPT, parseMeshFile, type MeshStats } from "@shared/stl-mesh";
import {
  DEFAULT_ADDON_AMOUNTS,
  DEFAULT_STL_QUOTE_SETTINGS,
  buildQuoteSummary,
  formatDims,
  overallDims,
  scaleForTarget,
  unmeasurableReason,
  type TargetSizeMode,
  PHROZEN_POWER_GUIDE_URL,
  computeStlQuote,
  resinCostPerMl,
  searchTermFromFileName,
  suggestFinalPrice,
  type MarketCheckResult,
  type PackagingTier,
  type QuotePart,
  type StlQuoteSettings,
} from "@shared/stl-quote";
import {
  activeChips,
  applyNoteChips,
  interpretNotes,
  markOverridden,
  notesSummaryLines,
  type NoteChip,
  type NoteField,
  type QuoteModifierState,
} from "@shared/quote-notes";

type LoadedPart = QuotePart & { id: string; stats: MeshStats };
type PartError = { id: string; name: string; error: string };

const usd = (n: number) => `$${n.toFixed(2)}`;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

function Row({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className={strong ? "text-sm font-semibold" : "text-sm"}>{label}</p>
        {hint ? <p className="break-words text-[0.6875rem] leading-4 text-muted-foreground">{hint}</p> : null}
      </div>
      <p className={`shrink-0 tabular-nums ${strong ? "text-base font-semibold" : "text-sm"}`}>{value}</p>
    </div>
  );
}

function NumField({
  id,
  label,
  value,
  onChange,
  step = "any",
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: string;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
        {suffix ? <span className="text-muted-foreground"> ({suffix})</span> : null}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        type="number"
        step={step}
        value={text}
        data-testid={`input-${id}`}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
      />
    </div>
  );
}

function AddOnRow({ id, label, on, notes, onToggle, children }: { id: string; label: string; on: boolean; notes?: boolean; onToggle: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 rounded-md border p-2 ${on ? "border-primary/50" : "border-border/70"}`}>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm" data-testid={`toggle-addon-${id}`}>
        <input type="checkbox" className="h-5 w-5 accent-[hsl(var(--primary))]" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        {label}
        <FromNotes on={!!notes} />
      </label>
      {on ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

function FromNotes({ on }: { on: boolean }) {
  return on ? <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.625rem] font-medium normal-case tracking-normal text-primary" data-testid="badge-from-notes">from notes</span> : null;
}

function NoteChipRow({ chip, state, onRemove, onRestore, onAccept }: { chip: NoteChip; state: "applied" | "removed" | "suggested" | "overridden"; onRemove: () => void; onRestore: () => void; onAccept: () => void }) {
  const tone =
    state === "applied" ? "border-primary/60 bg-primary/10" : state === "suggested" ? "border-dashed border-amber-500/70 bg-amber-500/5" : "border-border/70 opacity-70";
  return (
    <li className={`flex min-w-0 items-start gap-2 rounded-md border p-2 ${tone}`} data-testid={`chip-note-${state}`} data-chip-field={chip.change.field}>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${state === "removed" || state === "overridden" ? "line-through" : ""}`}>
          {state === "applied" ? <Check className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden /> : chip.origin === "ai" ? <Sparkles className="mr-1 inline h-3.5 w-3.5" aria-hidden /> : null}
          {chip.label}
        </p>
        <p className="break-words text-[0.6875rem] leading-4 text-muted-foreground">
          “{chip.source}”
          {state === "suggested" ? " · suggested, tap Apply to use it" : state === "removed" ? " · removed" : state === "overridden" ? " · a later note for the same setting wins" : ""}
          {chip.detail ? ` · ${chip.detail}` : ""}
        </p>
      </div>
      {state === "applied" ? (
        <Button type="button" size="icon" variant="ghost" className="h-11 w-11 shrink-0" aria-label={`Remove ${chip.label}`} onClick={onRemove} data-testid="button-chip-remove"><X className="h-4 w-4" /></Button>
      ) : state === "suggested" ? (
        <div className="flex shrink-0 gap-1">
          <Button type="button" size="sm" className="h-11" onClick={onAccept} data-testid="button-chip-accept">Apply</Button>
          <Button type="button" size="icon" variant="ghost" className="h-11 w-11" aria-label={`Dismiss ${chip.label}`} onClick={onRemove}><X className="h-4 w-4" /></Button>
        </div>
      ) : state === "removed" ? (
        <Button type="button" size="sm" variant="ghost" className="h-11 shrink-0" onClick={onRestore} data-testid="button-chip-restore"><Undo2 className="mr-1 h-4 w-4" />Re-apply</Button>
      ) : null}
    </li>
  );
}

const selectClass =
  "flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base shadow-xs md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function QuotePage() {
  const { toast } = useToast();
  const { isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({ successTitle: "Quote unlocked" });

  const settingsQuery = useQuery<{ settings: StlQuoteSettings; updatedAt: string | null }>({
    queryKey: ["/api/stl-quote/settings"],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/stl-quote/settings", undefined, { headers })).json(),
  });
  const [draft, setDraft] = useState<StlQuoteSettings>(DEFAULT_STL_QUOTE_SETTINGS);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (settingsQuery.data && !dirty) setDraft(settingsQuery.data.settings);
  }, [settingsQuery.data, dirty]);
  const edit = (patch: Partial<StlQuoteSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const [parts, setParts] = useState<LoadedPart[]>([]);
  const [errors, setErrors] = useState<PartError[]>([]);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [printerId, setPrinterId] = useState<string>("");
  const [hollow, setHollow] = useState(false);
  const [tier, setTier] = useState<PackagingTier | "auto">("auto");
  const [quantity, setQuantity] = useState(1);
  const [splOverride, setSplOverride] = useState<string>("");
  const [term, setTerm] = useState("");
  const [termTouched, setTermTouched] = useState(false);
  const [market, setMarket] = useState<MarketCheckResult | null>(null);
  const [sizeMode, setSizeMode] = useState<TargetSizeMode>("percent");
  const [sizeValue, setSizeValue] = useState("");
  const [separate, setSeparate] = useState(false);
  const [clientNotes, setClientNotes] = useState("");
  const [removedChips, setRemovedChips] = useState<Set<string>>(() => new Set());
  const [acceptedChips, setAcceptedChips] = useState<Set<string>>(() => new Set());
  const [aiChips, setAiChips] = useState<NoteChip[]>([]);
  const [addOn, setAddOn] = useState({
    rush: false, rushUsd: DEFAULT_ADDON_AMOUNTS.rushUsd,
    base: false, baseUsd: DEFAULT_ADDON_AMOUNTS.baseMagnetUsdEach,
    finishing: false, finHours: DEFAULT_ADDON_AMOUNTS.finishingHours, finRate: DEFAULT_ADDON_AMOUNTS.finishingUsdPerHour,
    custom: false, customLabel: "Custom fee", customUsd: DEFAULT_ADDON_AMOUNTS.customUsd,
  });

  useEffect(() => {
    if (!printerId) setPrinterId(draft.defaultPrinterId);
  }, [draft.defaultPrinterId, printerId]);
  useEffect(() => {
    if (!termTouched) setTerm(parts[0] ? searchTermFromFileName(parts[0].name) : "");
  }, [parts, termTouched]);

  async function addFiles(list: FileList | File[]) {
    setParsing(true);
    const next: LoadedPart[] = [];
    const errs: PartError[] = [];
    for (const file of Array.from(list)) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        if (file.size > MAX_FILE_BYTES) throw new Error("File is over 200 MB");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const stats = parseMeshFile(file.name, bytes);
        next.push({ id, name: file.name, stats, volumeMl: stats.volumeMl, surfaceAreaMm2: stats.surfaceAreaMm2, heightMm: stats.heightMm, bbox: stats.bbox });
      } catch (error) {
        errs.push({ id, name: file.name, error: error instanceof Error ? error.message : "Could not read file" });
      }
    }
    setParts((p) => [...p, ...next]);
    setErrors(errs);
    setMarket(null);
    setParsing(false);
  }

  // ---- client notes -> modifier chips (deterministic parser; AI only on request)
  const interp = useMemo(() => interpretNotes(clientNotes), [clientNotes]);
  const allChips = useMemo(() => {
    const lc = clientNotes.toLowerCase();
    const ai = aiChips.filter((c) => lc.includes(c.source.toLowerCase()) && !interp.chips.some((p) => p.change.field === c.change.field && JSON.stringify(p.change) === JSON.stringify(c.change)));
    return [...interp.chips, ...ai];
  }, [interp, aiChips, clientNotes]);
  const liveChips = useMemo(() => activeChips(allChips, removedChips, acceptedChips), [allChips, removedChips, acceptedChips]);
  const chipView = useMemo(() => {
    const on = (c: NoteChip) => !removedChips.has(c.id) && (c.confidence === "sure" || acceptedChips.has(c.id));
    return markOverridden(allChips, on).map((c) => ({
      chip: c,
      state: (c.overridden ? "overridden" : on(c) ? "applied" : removedChips.has(c.id) && c.confidence === "sure" ? "removed" : removedChips.has(c.id) ? "hidden" : "suggested") as "applied" | "removed" | "suggested" | "overridden" | "hidden",
    })).filter((v) => v.state !== "hidden");
  }, [allChips, removedChips, acceptedChips]);
  const unparsedNotes = useMemo(() => {
    const liveIds = new Set(liveChips.map((c) => c.id));
    const covered = aiChips.filter((c) => liveIds.has(c.id)).map((c) => c.source.toLowerCase());
    return interp.unparsed.filter((u) => !covered.some((src) => u.toLowerCase().includes(src)));
  }, [interp, aiChips, liveChips]);
  const manual: QuoteModifierState = { sizeMode, sizeValue, quantity, hollow, separate, addOn };
  const eff = applyNoteChips(manual, liveChips);
  const fromNotes = new Set<NoteField>(liveChips.map((c) => c.change.field));
  /** A manual edit wins over notes: drop the live chips for that setting. */
  const dismissField = (field: NoteField) => {
    const ids = liveChips.filter((c) => c.change.field === field).map((c) => c.id);
    if (ids.length) setRemovedChips((r) => new Set([...r, ...ids]));
  };
  const ADDON_FIELD = { rush: ["rush", "rushUsd"], baseMagnet: ["base", "baseUsd"], finishing: ["finishing", "finHours", "finRate"], custom: ["custom", "customLabel", "customUsd"] } as const;
  const editAddOn = (field: keyof typeof ADDON_FIELD, patch: Partial<typeof addOn>) => {
    const carry = Object.fromEntries(ADDON_FIELD[field].map((k) => [k, eff.addOn[k]]));
    setAddOn((prev) => ({ ...prev, ...carry, ...patch }));
    dismissField(field);
  };
  const aiStatus = useQuery<{ available: boolean; model: string | null }>({
    queryKey: ["/api/stl-quote/notes-ai"],
    enabled: isUnlocked,
    staleTime: 5 * 60_000,
    queryFn: async () => (await apiRequest("GET", "/api/stl-quote/notes-ai", undefined, { headers })).json(),
  });
  const askAi = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/stl-quote/notes-ai", { notes: clientNotes, unparsed: unparsedNotes }, { headers })).json() as Promise<{ chips: NoteChip[] }>,
    onSuccess: (data) => {
      setAiChips((prev) => [...prev.filter((p) => !data.chips.some((c) => c.id === p.id)), ...data.chips]);
      toast({ title: data.chips.length ? `AI found ${data.chips.length} suggestion${data.chips.length > 1 ? "s" : ""}` : "AI found nothing it could apply", description: data.chips.length ? "Check each one and tap Apply." : "Those notes stay as plain notes." });
    },
    onError: (e: Error) => toast({ title: "AI read failed", description: e.message, variant: "destructive" }),
  });

  const unmeasurable = unmeasurableReason(parts);
  const origDims = parts.length ? overallDims(parts) : null;
  const scale = origDims && eff.sizeValue.trim() ? scaleForTarget(eff.sizeMode, Number(eff.sizeValue), origDims) : 1;

  const quote = useMemo(() => {
    if (parts.length === 0 || unmeasurable) return null;
    const spl = Number(splOverride);
    const a = eff.addOn;
    return computeStlQuote(parts, draft, {
      printerId,
      hollow: eff.hollow,
      packagingTier: tier === "auto" ? null : tier,
      quantity: eff.quantity,
      secondsPerLayer: splOverride.trim() && Number.isFinite(spl) && spl > 0 ? spl : null,
      scale,
      separatePackages: eff.separate,
      addOns: {
        rushUsd: a.rush ? a.rushUsd : null,
        baseMagnetUsdEach: a.base ? a.baseUsd : null,
        finishing: a.finishing ? { hours: a.finHours, usdPerHour: a.finRate } : null,
        custom: a.custom ? { label: a.customLabel, usd: a.customUsd } : null,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, draft, printerId, tier, splOverride, scale, unmeasurable, JSON.stringify(eff)]);

  const suggestion = quote ? suggestFinalPrice(quote, market?.stats ?? null) : null;

  async function copySummary() {
    if (!quote) return;
    const text = buildQuoteSummary({ items: parts.map((p) => p.name), quote, hollow: eff.hollow, clientNotes, suggested: suggestion, notesLines: notesSummaryLines(liveChips, unparsedNotes) });
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Quote summary copied" });
    } catch {
      window.prompt("Copy the quote summary:", text);
    }
  }

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PUT", "/api/stl-quote/settings", { settings: draft }, { headers })).json(),
    onSuccess: (data: { settings: StlQuoteSettings }) => {
      setDirty(false);
      setDraft(data.settings);
      queryClient.setQueryData(["/api/stl-quote/settings"], data);
      toast({ title: "Quote settings saved" });
    },
    onError: (e: Error) => toast({ title: "Could not save settings", description: e.message, variant: "destructive" }),
  });
  const reset = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", "/api/stl-quote/settings", undefined, { headers })).json(),
    onSuccess: (data: { settings: StlQuoteSettings }) => {
      setDirty(false);
      setDraft(data.settings);
      queryClient.setQueryData(["/api/stl-quote/settings"], data);
      toast({ title: "Quote settings reset to defaults" });
    },
  });
  const check = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/stl-quote/market", { query: term }, { headers })).json() as Promise<MarketCheckResult>,
    onSuccess: (data) => setMarket(data),
    onError: (e: Error) => toast({ title: "Market check failed", description: e.message, variant: "destructive" }),
  });

  const activePrinters = draft.printers.filter((p) => !p.parked);

  return (
    <div className="mx-auto w-full max-w-6xl overflow-x-hidden pb-24 md:pb-6">
      <PageHeader title="Quote" subtitle="Drop STL, OBJ, or 3MF files to price a resin print from cost, with the 2x / 3x / 4x quote markups and a market check." />
      {!isUnlocked ? (
        <div className="px-4 md:px-8">
          <OwnerUnlockPanel
            title="Unlock Quote"
            description="Enter the owner code to price prints and edit quote settings."
            buttonLabel="Unlock Quote"
            testIdPrefix="quote"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 px-4 md:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <Panel title="Models" description="Measured in your browser. Files are not uploaded." testId="panel-quote-models">
              <label
                htmlFor="quote-files"
                className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center text-sm ${dragOver ? "border-primary bg-primary/5" : "border-border"}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
                }}
                data-testid="dropzone-quote"
              >
                {parsing ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileUp className="h-5 w-5" />}
                <span className="font-medium">Drop files or tap to choose</span>
                <span className="text-xs text-muted-foreground">STL (binary or ASCII), OBJ, 3MF · several files = one plate</span>
              </label>
              <input
                ref={fileInput}
                id="quote-files"
                type="file"
                multiple
                accept={MESH_FILE_ACCEPT}
                className="sr-only"
                data-testid="input-quote-files"
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {errors.map((er) => (
                <p key={er.id} className="mt-2 break-words text-xs text-destructive">
                  {er.name}: {er.error}
                </p>
              ))}
              {parts.length > 0 ? (
                <ul className="mt-3 space-y-2" data-testid="list-quote-parts">
                  {parts.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-2 rounded-md border border-border/70 p-2.5">
                      <div className="min-w-0">
                        <p className="break-all text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {p.volumeMl.toFixed(2)} ml · {p.bbox.x.toFixed(1)} × {p.bbox.y.toFixed(1)} × {p.bbox.z.toFixed(1)} mm · height {p.heightMm.toFixed(1)} mm
                        </p>
                        <p className="text-[0.6875rem] text-muted-foreground">
                          {p.stats.format} · {p.stats.triangles.toLocaleString()} triangles{p.stats.inverted ? " · inverted normals (volume still measured)" : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${p.name}`}
                        onClick={() => {
                          setParts((all) => all.filter((x) => x.id !== p.id));
                          setMarket(null);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {unmeasurable ? (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-3" role="status" data-testid="notice-quote-load-stl">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">Load an STL to price</p>
                    <p className="break-words text-xs text-muted-foreground">
                      {unmeasurable === "none"
                        ? "No model is loaded, so there is no quote yet. Notes and modifiers you set now are kept and apply as soon as a model is in."
                        : `This model measures ${unmeasurable}, so there is nothing to price. The file may be empty, broken, or exported in meters. Load a real STL, OBJ, or 3MF.`}
                    </p>
                  </div>
                </div>
              ) : null}
            </Panel>

            <Panel title="Modifiers" description="Adjust for what the client wants. Everything recomputes live." testId="panel-quote-modifiers">
              <div className="space-y-4">
                <section aria-labelledby="mod-notes" className="min-w-0" data-testid="section-quote-notes">
                  <Label htmlFor="quote-client-notes" id="mod-notes" className="rule-label">Client notes</Label>
                  <Textarea id="quote-client-notes" className="mt-1 min-h-[88px]" placeholder={'What the client asked for, e.g. "6mm tall, set of 3, magnetized base, need it by Friday, +$10 for decals"'} value={clientNotes} onChange={(e) => setClientNotes(e.target.value)} data-testid="input-quote-client-notes" />
                  <p className="mt-1 text-[0.6875rem] text-muted-foreground">Sizes, copies, rush/deadline, base/magnet, painting/cleanup, hollow/solid, separate packaging, and +$ fees are read from the notes and applied below. Remove a chip or change the setting by hand to override it.</p>
                  {chipView.length || unparsedNotes.length ? (
                    <div className="mt-2 space-y-2" data-testid="block-quote-notes-applied">
                      {chipView.length ? (
                        <>
                          <p className="rule-label">Applied from notes</p>
                          <ul className="space-y-1.5">
                            {chipView.map(({ chip, state }) => (
                              <NoteChipRow
                                key={chip.id}
                                chip={chip}
                                state={state as "applied" | "removed" | "suggested" | "overridden"}
                                onRemove={() => setRemovedChips((r) => new Set([...r, chip.id]))}
                                onRestore={() => setRemovedChips((r) => { const n = new Set(r); n.delete(chip.id); return n; })}
                                onAccept={() => {
                                  setAcceptedChips((a) => new Set([...a, chip.id]));
                                  setRemovedChips((r) => { const n = new Set(r); n.delete(chip.id); return n; });
                                }}
                              />
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {unparsedNotes.length ? (
                        <div className="rounded-md border border-border/70 p-2" data-testid="block-quote-notes-unparsed">
                          <p className="text-xs font-medium">Not applied (kept as notes)</p>
                          <ul className="mt-1 space-y-0.5">
                            {unparsedNotes.map((u, i) => (
                              <li key={`${u}-${i}`} className="break-words text-xs text-muted-foreground" data-testid="text-note-not-applied">“{u}” · no matching modifier, price it by hand if it matters</li>
                            ))}
                          </ul>
                          {aiStatus.data?.available ? (
                            <Button type="button" variant="outline" size="sm" className="mt-2 h-11" disabled={askAi.isPending} onClick={() => askAi.mutate()} data-testid="button-quote-notes-ai">
                              {askAi.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                              Ask AI to read these
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <Button type="button" variant="outline" className="mt-2 h-11 w-full sm:w-auto" disabled={!quote} onClick={copySummary} data-testid="button-quote-copy-summary">
                    <Copy className="mr-1.5 h-4 w-4" /> Copy quote summary
                  </Button>
                  <p className="mt-1 text-[0.6875rem] text-muted-foreground">Copies plain text (with the notes and what was applied) to your clipboard only. Nothing is sent or saved.</p>
                </section>

                <section aria-labelledby="mod-size" className="min-w-0">
                  <h3 id="mod-size" className="rule-label mb-2">Target size (aspect locked)<FromNotes on={fromNotes.has("size")} /></h3>
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="quote-size-mode" className="text-xs">By</Label>
                      <select id="quote-size-mode" className={selectClass} value={eff.sizeMode} onChange={(e) => { setSizeMode(e.target.value as TargetSizeMode); setSizeValue(eff.sizeValue); dismissField("size"); }} data-testid="select-quote-size-mode">
                        <option value="percent">Scale %</option>
                        <option value="height">Target height (mm)</option>
                        <option value="width">Target width (mm)</option>
                        <option value="depth">Target depth (mm)</option>
                        <option value="longest">Target longest side (mm)</option>
                      </select>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="quote-size-value" className="text-xs">{eff.sizeMode === "percent" ? "Scale %" : "mm"}</Label>
                      <Input id="quote-size-value" type="number" inputMode="decimal" step="any" placeholder={eff.sizeMode === "percent" ? "100" : origDims ? (eff.sizeMode === "height" ? origDims.z : eff.sizeMode === "width" ? origDims.x : eff.sizeMode === "depth" ? origDims.y : Math.max(origDims.x, origDims.y, origDims.z)).toFixed(1) : ""} value={eff.sizeValue} onChange={(e) => { setSizeMode(eff.sizeMode); setSizeValue(e.target.value); dismissField("size"); }} data-testid="input-quote-size-value" />
                    </div>
                  </div>
                  {quote ? (
                    <div className="mt-2 grid min-w-0 grid-cols-2 gap-2 text-xs" data-testid="block-quote-dims">
                      <div className="min-w-0 rounded-md border border-border/70 p-2">
                        <p className="rule-label">Original</p>
                        <p className="tabular-nums">{formatDims(quote.originalDims)}</p>
                        <p className="text-muted-foreground tabular-nums">{quote.originalModelMl.toFixed(2)} ml</p>
                      </div>
                      <div className={`min-w-0 rounded-md border p-2 ${quote.scale !== 1 ? "border-primary/50 bg-primary/5" : "border-border/70"}`}>
                        <p className="rule-label">Scaled · {(quote.scale * 100).toFixed(quote.scale * 100 % 1 ? 1 : 0)}%</p>
                        <p className="tabular-nums font-medium">{formatDims(quote.scaledDims)}</p>
                        <p className="text-muted-foreground tabular-nums">{(quote.modelMl / quote.quantity).toFixed(2)} ml each{eff.hollow ? " (hollow)" : ""}</p>
                      </div>
                      {quote.fit.status === "too-big" ? (
                        <p className="col-span-2 rounded-md border border-destructive/60 bg-destructive/10 p-2 text-destructive" role="alert" data-testid="text-quote-fit-warning">{quote.fit.detail}</p>
                      ) : (
                        <p className="col-span-2 text-muted-foreground">{quote.fit.detail}</p>
                      )}
                    </div>
                  ) : null}
                  {eff.sizeValue ? (
                    <Button type="button" variant="ghost" size="sm" className="mt-1 h-11" onClick={() => { setSizeValue(""); dismissField("size"); }}>Reset to original size</Button>
                  ) : null}
                </section>

                <section aria-labelledby="mod-print" className="min-w-0">
                  <h3 id="mod-print" className="rule-label mb-2">Print and packaging<FromNotes on={fromNotes.has("quantity") || fromNotes.has("hollow") || fromNotes.has("separatePackages")} /></h3>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="quote-printer" className="text-xs">Printer</Label>
                      <select id="quote-printer" className={selectClass} value={printerId} onChange={(e) => setPrinterId(e.target.value)} data-testid="select-quote-printer">
                        {activePrinters.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · {p.watts ?? "?"} W
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="quote-tier" className="text-xs">Packaging</Label>
                      <select id="quote-tier" className={selectClass} value={tier} onChange={(e) => setTier(e.target.value as PackagingTier | "auto")} data-testid="select-quote-packaging">
                        <option value="auto">Auto{quote ? ` (${quote.suggestedPackagingTier})` : ""}</option>
                        <option value="small">Small · {usd(draft.packagingUsd.small)}</option>
                        <option value="medium">Medium · {usd(draft.packagingUsd.medium)}</option>
                        <option value="large">Large · {usd(draft.packagingUsd.large)}</option>
                      </select>
                    </div>
                    <NumField id="quote-qty" label={fromNotes.has("quantity") ? "Copies (from notes)" : "Copies"} value={eff.quantity} step="1" onChange={(n) => { setQuantity(Math.max(1, Math.floor(n))); dismissField("quantity"); }} />
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="quote-spl" className="text-xs">Seconds per layer <span className="text-muted-foreground">(blank = printer default)</span></Label>
                      <Input id="quote-spl" type="number" inputMode="decimal" step="any" placeholder={String(draft.printers.find((p) => p.id === printerId)?.secondsPerLayer ?? 8)} value={splOverride} onChange={(e) => setSplOverride(e.target.value)} />
                    </div>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm" data-testid="toggle-quote-separate">
                      <input type="checkbox" className="h-5 w-5 accent-[hsl(var(--primary))]" checked={eff.separate} onChange={(e) => { setSeparate(e.target.checked); dismissField("separatePackages"); }} />
                      Package each copy separately<FromNotes on={fromNotes.has("separatePackages")} />
                    </label>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm" data-testid="toggle-quote-hollow">
                      <input type="checkbox" className="h-5 w-5 accent-[hsl(var(--primary))]" checked={eff.hollow} onChange={(e) => { setHollow(e.target.checked); dismissField("hollow"); }} />
                      Hollow (est. {draft.hollowWallMm} mm wall), else solid<FromNotes on={fromNotes.has("hollow")} />
                    </label>
                  </div>
                  {quote?.notes.length ? <ul className="mt-2 space-y-0.5 text-[0.6875rem] text-muted-foreground">{quote.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
                </section>

                <section aria-labelledby="mod-addons" className="min-w-0">
                  <h3 id="mod-addons" className="rule-label mb-2">Add-ons (added to cost before markups)</h3>
                  <div className="space-y-2">
                    <AddOnRow id="rush" label="Rush" notes={fromNotes.has("rush")} on={eff.addOn.rush} onToggle={(v) => editAddOn("rush", { rush: v })}>
                      <NumField id="addon-rush" label="$ flat" value={eff.addOn.rushUsd} onChange={(n) => editAddOn("rush", { rush: true, rushUsd: n })} />
                    </AddOnRow>
                    <AddOnRow id="base" label="Base / magnet" notes={fromNotes.has("baseMagnet")} on={eff.addOn.base} onToggle={(v) => editAddOn("baseMagnet", { base: v })}>
                      <NumField id="addon-base" label="$ per copy" value={eff.addOn.baseUsd} onChange={(n) => editAddOn("baseMagnet", { base: true, baseUsd: n })} />
                    </AddOnRow>
                    <AddOnRow id="finishing" label="Supports cleanup / finishing" notes={fromNotes.has("finishing")} on={eff.addOn.finishing} onToggle={(v) => editAddOn("finishing", { finishing: v })}>
                      <div className="grid grid-cols-2 gap-2">
                        <NumField id="addon-fin-h" label="Hours" value={eff.addOn.finHours} onChange={(n) => editAddOn("finishing", { finishing: true, finHours: n })} />
                        <NumField id="addon-fin-r" label="$/hr" value={eff.addOn.finRate} onChange={(n) => editAddOn("finishing", { finishing: true, finRate: n })} />
                      </div>
                    </AddOnRow>
                    <AddOnRow id="custom" label="Custom fee" notes={fromNotes.has("custom")} on={eff.addOn.custom} onToggle={(v) => editAddOn("custom", { custom: v })}>
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)] gap-2">
                        <div className="min-w-0 space-y-1">
                          <Label htmlFor="addon-custom-label" className="text-xs">Label</Label>
                          <Input id="addon-custom-label" value={eff.addOn.customLabel} onChange={(e) => editAddOn("custom", { custom: true, customLabel: e.target.value })} />
                        </div>
                        <NumField id="addon-custom" label="$" value={eff.addOn.customUsd} onChange={(n) => editAddOn("custom", { custom: true, customUsd: n })} />
                      </div>
                    </AddOnRow>
                  </div>
                </section>
              </div>
            </Panel>
          </div>

          <div className="min-w-0 space-y-4">
            <Panel title="Cost" description="Estimates from mesh volume, layer count, and your settings." testId="panel-quote-cost">
              {!quote ? (
                <p className="text-sm font-medium" data-testid="text-quote-cost-empty">Load an STL to price. {unmeasurable && unmeasurable !== "none" ? "The loaded model has no measurable size." : "No model loaded yet."}</p>
              ) : (
                <div>
                  <Row label="Resin" value={usd(quote.costs.resin)} hint={`${quote.totalResinMl.toFixed(2)} ml incl. support estimate · ${quote.math.resin}`} />
                  <Row label="Electricity" value={usd(quote.costs.electricity)} hint={quote.math.electricity} />
                  <Row label="Plate time" value={usd(quote.costs.plateTime)} hint={quote.math.plateTime} />
                  <Row label="Packaging" value={usd(quote.costs.packaging)} hint={quote.math.packaging} />
                  {quote.addOnLines.map((l) => (
                    <Row key={l.key} label={l.label} value={usd(l.usd)} hint={`Add-on · ${l.detail}`} />
                  ))}
                  <Row label="Raw cost" value={usd(quote.rawCost)} strong hint={`Print time estimate ${quote.math.printTime}`} />
                </div>
              )}
            </Panel>

            {quote ? (
              <Panel title="Price" description="Both views side by side." testId="panel-quote-price">
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0 rounded-md border border-border/70 p-3" data-testid="card-quote-flat">
                    <p className="rule-label">Cost + flat markup</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">{usd(quote.flatPrice)}</p>
                    <p className="text-xs text-muted-foreground">
                      {usd(quote.rawCost)} + {quote.flatMarkupPct}% (replaces machine wear / complexity)
                    </p>
                  </div>
                  <div className="min-w-0 rounded-md border border-border/70 p-3" data-testid="card-quote-markups">
                    <p className="rule-label">Quote markups on cost</p>
                    <Row label={`Don't go below (${quote.markups.multipliers.dontGoBelow}x)`} value={usd(quote.markups.dontGoBelow)} />
                    <Row label={`Floor (${quote.markups.multipliers.floor}x)`} value={usd(quote.markups.floor)} />
                    <Row label={`Ask (${quote.markups.multipliers.ask}x)`} value={usd(quote.markups.ask)} strong />
                    <p className="mt-1 text-[0.6875rem] text-muted-foreground">Same rules as prometheus-quote: min {usd(draft.minimumQuoteUsd)}, charm-rounded to $x4.99 / $x9.99.</p>
                  </div>
                </div>
              </Panel>
            ) : null}

            {quote ? (
              <Panel title="Market check" description="Live Etsy and eBay listing prices. Nothing is made up: if a site blocks us you will see that here." testId="panel-quote-market">
                <form
                  className="flex min-w-0 flex-col gap-2 sm:flex-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (term.trim().length >= 2) check.mutate();
                  }}
                >
                  <Input
                    aria-label="Market search term"
                    className="min-w-0 flex-1"
                    value={term}
                    onChange={(e) => {
                      setTerm(e.target.value);
                      setTermTouched(true);
                    }}
                    data-testid="input-quote-market-term"
                  />
                  <Button type="submit" disabled={check.isPending || term.trim().length < 2} data-testid="button-quote-check-market">
                    {check.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Search className="mr-1.5 h-4 w-4" />}
                    Check market
                  </Button>
                </form>
                {market ? (
                  <div className="mt-3 space-y-3" data-testid="block-quote-market-result">
                    {market.stats ? (
                      <div className="grid grid-cols-3 gap-2 text-center">
                        {(["low", "median", "high"] as const).map((k) => (
                          <div key={k} className="rounded-md border border-border/70 p-2">
                            <p className="rule-label">{k}</p>
                            <p className="text-base font-semibold tabular-nums">{usd(market.stats![k])}</p>
                          </div>
                        ))}
                        <p className="col-span-3 text-xs text-muted-foreground">{market.stats.count} listings · checked {new Date(market.checkedAt).toLocaleString()}</p>
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed border-border p-3 text-sm" data-testid="text-quote-market-unavailable">
                        <p className="font-medium">Market data unavailable</p>
                        <p className="mt-1 text-xs text-muted-foreground">No comps were found or the sites blocked the request. The suggested price below uses cost only.</p>
                      </div>
                    )}
                    <ul className="space-y-1 text-xs">
                      {market.sources.map((s) => (
                        <li key={s.source} className="break-words">
                          <span className="font-medium">{s.source}</span>: {s.status} ({s.method}) · {s.detail}
                        </li>
                      ))}
                    </ul>
                    {market.credentialsNeeded.length ? (
                      <p className="break-words text-xs text-muted-foreground">To make this reliable, add on Railway: {market.credentialsNeeded.join("; ")}.</p>
                    ) : null}
                    {market.comps.length ? (
                      <ul className="max-h-64 space-y-1 overflow-y-auto overflow-x-hidden">
                        {[...market.comps].sort((a, b) => a.priceUsd - b.priceUsd).map((c, i) => (
                          <li key={`${c.url}-${i}`}>
                            <a href={c.url} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-between gap-2 rounded px-1 text-sm hover:bg-muted">
                              <span className="min-w-0 truncate">
                                <span className="text-muted-foreground">{c.source}</span> · {c.title || "listing"}
                              </span>
                              <span className="flex shrink-0 items-center gap-1 tabular-nums">
                                {usd(c.priceUsd)} <ExternalLink className="h-3 w-3" />
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {suggestion ? (
                  <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="card-quote-suggested">
                    <p className="rule-label">Suggested final price</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">{usd(suggestion.price)}</p>
                    <p className="text-xs text-muted-foreground">{market ? suggestion.rule : "Run Check market to compare. " + suggestion.rule}</p>
                    <p className="mt-1 text-[0.6875rem] text-muted-foreground">Rule: price at the market median, but never under the {quote?.markups.multipliers.floor}x floor; no market data = the cost-based ask. Postage at label cost.</p>
                  </div>
                ) : null}
              </Panel>
            ) : null}
          </div>

          <div className="min-w-0 lg:col-span-2">
            <Panel
              title="Quote settings"
              description={settingsQuery.data?.updatedAt ? `Saved ${new Date(settingsQuery.data.updatedAt).toLocaleString()}` : "Defaults (not saved yet)"}
              testId="panel-quote-settings"
              actions={
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => reset.mutate()} disabled={reset.isPending}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" /> Defaults
                  </Button>
                  <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending} data-testid="button-quote-save-settings">
                    <Save className="mr-1 h-3.5 w-3.5" /> Save
                  </Button>
                </div>
              }
            >
              <details className="group" open={false}>
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Edit resin, electricity, time, packaging, and markups</summary>
                <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="min-w-0 space-y-1 sm:col-span-2">
                    <Label htmlFor="qs-resin" className="text-xs">Resin</Label>
                    <Input id="qs-resin" value={draft.resinName} onChange={(e) => edit({ resinName: e.target.value })} />
                  </div>
                  <NumField id="qs-bottle" label="Bottle price" suffix="$" value={draft.bottlePriceUsd} onChange={(n) => edit({ bottlePriceUsd: n })} />
                  <NumField id="qs-mass" label="Bottle size" suffix="g" value={draft.bottleMassG} onChange={(n) => edit({ bottleMassG: n })} />
                  <NumField id="qs-density" label="Density" suffix="g/ml" value={draft.resinDensityGPerMl} onChange={(n) => edit({ resinDensityGPerMl: n })} />
                  <NumField id="qs-waste" label="Waste factor" value={draft.wasteFactor} onChange={(n) => edit({ wasteFactor: n })} />
                  <NumField id="qs-support" label="Support allowance (estimate)" suffix="%" value={draft.supportAllowancePct} onChange={(n) => edit({ supportAllowancePct: n })} />
                  <NumField id="qs-wall" label="Hollow wall (estimate)" suffix="mm" value={draft.hollowWallMm} onChange={(n) => edit({ hollowWallMm: n })} />
                  <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">= ${resinCostPerMl(draft).toFixed(4)} per ml</p>
                  <NumField id="qs-kwh" label="Electricity" suffix="$/kWh" value={draft.electricityUsdPerKwh} onChange={(n) => edit({ electricityUsdPerKwh: n })} />
                  <NumField id="qs-layer" label="Layer height" suffix="mm" value={draft.layerHeightMm} onChange={(n) => edit({ layerHeightMm: n })} />
                  <NumField id="qs-plate" label="Plate time" suffix="$/hr" value={draft.plateTimeUsdPerHour} onChange={(n) => edit({ plateTimeUsdPerHour: n })} />
                  <NumField id="qs-flat" label="Flat markup" suffix="%" value={draft.flatMarkupPct} onChange={(n) => edit({ flatMarkupPct: n })} />
                  <p className="break-words text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
                    {draft.electricityNote}{" "}
                    {draft.electricityUrl ? (
                      <a className="hs-link tap-ext" href={draft.electricityUrl} target="_blank" rel="noreferrer">Source</a>
                    ) : null}
                  </p>
                  <NumField id="qs-pk-s" label="Small box" suffix="$" value={draft.packagingUsd.small} onChange={(n) => edit({ packagingUsd: { ...draft.packagingUsd, small: n } })} />
                  <NumField id="qs-pk-m" label="Medium box" suffix="$" value={draft.packagingUsd.medium} onChange={(n) => edit({ packagingUsd: { ...draft.packagingUsd, medium: n } })} />
                  <NumField id="qs-pk-l" label="Large box" suffix="$" value={draft.packagingUsd.large} onChange={(n) => edit({ packagingUsd: { ...draft.packagingUsd, large: n } })} />
                  <div className="grid grid-cols-2 gap-2">
                    <NumField id="qs-pk-smax" label="Small ≤" suffix="mm" value={draft.packagingMaxMm.small} onChange={(n) => edit({ packagingMaxMm: { ...draft.packagingMaxMm, small: n } })} />
                    <NumField id="qs-pk-mmax" label="Medium ≤" suffix="mm" value={draft.packagingMaxMm.medium} onChange={(n) => edit({ packagingMaxMm: { ...draft.packagingMaxMm, medium: n } })} />
                  </div>
                  <NumField id="qs-m-dgb" label="Don't go below" suffix="x cost" value={1 + draft.markups.dontGoBelow} onChange={(n) => edit({ markups: { ...draft.markups, dontGoBelow: Math.max(0, n - 1) } })} />
                  <NumField id="qs-m-floor" label="Floor" suffix="x cost" value={1 + draft.markups.floor} onChange={(n) => edit({ markups: { ...draft.markups, floor: Math.max(0, n - 1) } })} />
                  <NumField id="qs-m-ask" label="Ask" suffix="x cost" value={1 + draft.markups.ask} onChange={(n) => edit({ markups: { ...draft.markups, ask: Math.max(0, n - 1) } })} />
                  <NumField id="qs-min" label="Minimum quote" suffix="$" value={draft.minimumQuoteUsd} onChange={(n) => edit({ minimumQuoteUsd: n })} />
                </div>
                <h3 className="mt-5 text-sm font-semibold">Printers</h3>
                <p className="text-xs text-muted-foreground">
                  Watts and build volume are manufacturer specs (watts = rated / max system power; actual draw is usually lower). Build 0 = unknown, no fit warning. Seconds per layer are estimates (exposure + lift).{" "}
                  <a className="hs-link tap-ext" href={PHROZEN_POWER_GUIDE_URL} target="_blank" rel="noreferrer">Phrozen power guide</a>
                </p>
                <ul className="mt-2 space-y-2">
                  {draft.printers.map((p, idx) => (
                    <li key={p.id} className="grid min-w-0 gap-2 rounded-md border border-border/70 p-2.5 sm:grid-cols-[minmax(0,1fr)_7rem_7rem] lg:grid-cols-[minmax(0,1fr)_6rem_6rem_6rem_6rem_6rem]">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{p.name}{p.id === draft.defaultPrinterId ? " · default" : ""}</p>
                        <p className="break-words text-[0.6875rem] text-muted-foreground">
                          {p.specNote}{" "}
                          {p.specUrl ? (
                            <a className="hs-link tap-ext" href={p.specUrl} target="_blank" rel="noreferrer">Spec page</a>
                          ) : null}
                        </p>
                      </div>
                      {p.parked ? (
                        <p className="text-xs text-muted-foreground sm:col-span-2">Parked</p>
                      ) : (
                        <>
                          <NumField id={`qs-w-${p.id}`} label="Watts" value={p.watts ?? 0} onChange={(n) => edit({ printers: draft.printers.map((x, i) => (i === idx ? { ...x, watts: n } : x)) })} />
                          <NumField id={`qs-s-${p.id}`} label="s / layer" value={p.secondsPerLayer} onChange={(n) => edit({ printers: draft.printers.map((x, i) => (i === idx ? { ...x, secondsPerLayer: n } : x)) })} />
                          <div className="grid grid-cols-3 gap-2 sm:col-span-2 lg:col-span-3">
                            {(["x", "y", "z"] as const).map((ax) => (
                              <NumField
                                key={ax}
                                id={`qs-b${ax}-${p.id}`}
                                label={`Build ${ax === "x" ? "W" : ax === "y" ? "D" : "H"}`}
                                suffix="mm"
                                value={p.buildMm?.[ax] ?? 0}
                                onChange={(n) =>
                                  edit({
                                    printers: draft.printers.map((x, i) =>
                                      i === idx ? { ...x, buildMm: n > 0 ? { ...(x.buildMm ?? { x: 0, y: 0, z: 0 }), [ax]: n } : null } : x,
                                    ),
                                  })
                                }
                              />
                            ))}
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 max-w-sm space-y-1">
                  <Label htmlFor="qs-default-printer" className="text-xs">Default printer</Label>
                  <select id="qs-default-printer" className={selectClass} value={draft.defaultPrinterId} onChange={(e) => edit({ defaultPrinterId: e.target.value })}>
                    {activePrinters.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </details>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
