import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Lock, RefreshCw, WifiOff } from "lucide-react";
import { Panel, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getNerveKey, onNerveKeyChange, setNerveKey } from "@/lib/nerve";
import type { NerveError } from "@/lib/nerve";

/** Nerve key held in page memory only (see lib/nerve.ts). */
export function useNerveKey() {
  const [k, setK] = useState(getNerveKey());
  useEffect(() => onNerveKeyChange(() => setK(getNerveKey())), []);
  return k;
}

export function NerveUnlock({ title = "Unlock Nerve", description = "Held in this tab's memory only. Works only on a device connected to Tailscale." }: { title?: string; description?: string }) {
  const [v, setV] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNerveKey(v);
    setV("");
  };
  return (
    <Panel title={title} description={description} testId="panel-nerve-unlock">
      <form onSubmit={submit} className="flex max-w-md items-center gap-2">
        <Input type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder="Nerve key" data-testid="input-nerve-key" />
        <Button type="submit" data-testid="button-nerve-unlock">
          <Lock className="mr-1 h-4 w-4" /> Unlock
        </Button>
      </form>
    </Panel>
  );
}

export function NerveErrorState({ err, retry }: { err: NerveError; retry: () => void }) {
  return (
    <Panel title={err.kind === "offline" ? "Connect Tailscale" : "Nerve unavailable"} description={err.message} testId="panel-nerve-error">
      <div className="flex items-center gap-2">
        <StatusPill tone={err.kind === "offline" ? "neutral" : "bad"} icon={WifiOff} label={err.kind === "offline" ? "Off tailnet" : "Error"} />
        <Button variant="outline" size="sm" onClick={retry} data-testid="button-nerve-retry">
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    </Panel>
  );
}
