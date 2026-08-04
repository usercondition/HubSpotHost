import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { KeyRound, Loader2, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type OwnerSessionValue = {
  ownerCode: string;
  codeDraft: string;
  setCodeDraft: (value: string) => void;
  isUnlocked: boolean;
  headers: Record<string, string>;
  unlock: (code: string) => void;
  lock: () => void;
};

const OwnerSessionContext = createContext<OwnerSessionValue | null>(null);

/**
 * Session-scoped owner unlock for Daily work pages.
 * Lives in React memory only — cleared on full reload, never written to storage.
 */
export function OwnerSessionProvider({ children }: { children: ReactNode }) {
  const [ownerCode, setOwnerCode] = useState("");
  const [codeDraft, setCodeDraft] = useState("");

  const unlock = useCallback((code: string) => {
    setOwnerCode(code);
    setCodeDraft("");
  }, []);

  const lock = useCallback(() => {
    setOwnerCode("");
  }, []);

  const value = useMemo<OwnerSessionValue>(() => {
    const headers: Record<string, string> = {};
    if (ownerCode.length > 0) headers["x-paid-order-access-code"] = ownerCode;
    return {
      ownerCode,
      codeDraft,
      setCodeDraft,
      isUnlocked: ownerCode.length > 0,
      headers,
      unlock,
      lock,
    };
  }, [ownerCode, codeDraft, unlock, lock]);

  return <OwnerSessionContext.Provider value={value}>{children}</OwnerSessionContext.Provider>;
}

export function useOwnerSession(): OwnerSessionValue {
  const value = useContext(OwnerSessionContext);
  if (!value) {
    throw new Error("useOwnerSession must be used within OwnerSessionProvider");
  }
  return value;
}

export function OwnerUnlockPanel({
  title,
  description,
  buttonLabel,
  testIdPrefix,
  onUnlock,
  pending,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  testIdPrefix: string;
  onUnlock: (code: string) => void;
  pending?: boolean;
}) {
  const { codeDraft, setCodeDraft } = useOwnerSession();

  return (
    <section
      className="mx-auto max-w-lg rounded-lg border border-card-border bg-card p-5 md:p-6"
      aria-labelledby={`${testIdPrefix}-unlock-title`}
      data-testid={`panel-${testIdPrefix}-unlock`}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
        <KeyRound className="h-4 w-4" />
      </div>
      <p className="mt-4 rule-label">Owner access</p>
      <h2 id={`${testIdPrefix}-unlock-title`} className="mt-1 text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const code = codeDraft.trim();
          if (code) onUnlock(code);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`${testIdPrefix}-owner-code`}>Owner access code</Label>
          <Input
            id={`${testIdPrefix}-owner-code`}
            type="password"
            autoComplete="off"
            value={codeDraft}
            onChange={(event) => setCodeDraft(event.target.value)}
            placeholder="Enter your code"
            data-testid={`input-${testIdPrefix}-owner-code`}
          />
        </div>
        <Button
          type="submit"
          className="w-full"
          disabled={pending || codeDraft.trim().length === 0}
          data-testid={`button-unlock-${testIdPrefix}`}
        >
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unlock className="mr-2 h-4 w-4" />}
          {buttonLabel}
        </Button>
      </form>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Unlock once for this browser tab — Order links, Print files, Supplies, and Performance share the same session until you reload.
      </p>
    </section>
  );
}
