import { useEffect } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { Panel, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { clearLegacyNerveKeyStorage, forgetNerveKey } from "@/lib/nerve";
import type { NerveError } from "@/lib/nerve";

/**
 * Nerve unlocks with the Print Ops owner session. Returns the owner code ("" when locked).
 * There is no separate Nerve key anywhere in the browser.
 */
export function useNerveAccess() {
  const { ownerCode } = useOwnerSession();
  useEffect(() => clearLegacyNerveKeyStorage(), []);
  useEffect(() => {
    if (!ownerCode) forgetNerveKey();
  }, [ownerCode]);
  return ownerCode;
}

/** Shown only when Print Ops itself is locked: the same owner unlock as Daily Work. */
export function NerveUnlock({ title = "Unlock Print Ops to see Nerve", description = "Uses your normal Print Ops key." }: { title?: string; description?: string }) {
  const unlock = useOwnerUnlock({ successTitle: "Unlocked" });
  return (
    <OwnerUnlockPanel
      title={title}
      description={description}
      buttonLabel="Unlock"
      testIdPrefix="nerve"
      onUnlock={(code) => unlock.mutate(code)}
      pending={unlock.isPending}
    />
  );
}

export function NerveErrorState({ err, retry }: { err: NerveError; retry: () => void }) {
  return (
    <Panel title={err.kind === "offline" ? "Nerve offline — connect to Tailscale" : "Nerve unavailable"} description={err.message} testId="panel-nerve-error">
      <div className="flex items-center gap-2">
        <StatusPill tone={err.kind === "offline" ? "neutral" : "bad"} icon={WifiOff} label={err.kind === "offline" ? "Offline" : "Error"} />
        <Button variant="outline" size="sm" onClick={retry} data-testid="button-nerve-retry">
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    </Panel>
  );
}
