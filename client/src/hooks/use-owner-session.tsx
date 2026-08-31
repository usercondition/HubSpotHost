import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Unlock } from "lucide-react";
import { BrandMarkImage } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, onOwnerAuthFailure } from "@/lib/queryClient";
import { describeOwnerAuthError } from "@/lib/api-error";

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

/** Tab-scoped only (clears when the browser tab closes). Never localStorage. */
const OWNER_SESSION_KEY = "print-ops-owner-code";

function readSessionOwnerCode(): string {
  if (typeof sessionStorage === "undefined") return "";
  try {
    return sessionStorage.getItem(OWNER_SESSION_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeSessionOwnerCode(code: string) {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (code) sessionStorage.setItem(OWNER_SESSION_KEY, code);
    else sessionStorage.removeItem(OWNER_SESSION_KEY);
  } catch {
    // Private mode / blocked storage — unlock still works in memory.
  }
}

/**
 * Session-scoped owner unlock for Daily work pages.
 * Kept in this browser tab (sessionStorage) so a soft reload doesn't force
 * re-unlock; cleared on Lock, auth failure, or when the tab closes.
 */
export function OwnerSessionProvider({ children }: { children: ReactNode }) {
  const [ownerCode, setOwnerCode] = useState(readSessionOwnerCode);
  const [codeDraft, setCodeDraft] = useState("");
  const { toast } = useToast();

  const unlock = useCallback((code: string) => {
    setOwnerCode(code);
    writeSessionOwnerCode(code);
    setCodeDraft("");
  }, []);

  const lock = useCallback(() => {
    setOwnerCode("");
    writeSessionOwnerCode("");
  }, []);

  useEffect(() => {
    return onOwnerAuthFailure(() => {
      setOwnerCode((current) => {
        if (!current) return current;
        writeSessionOwnerCode("");
        toast({
          title: "Owner session expired",
          description: "Unlock again with your owner code to continue.",
          variant: "destructive",
        });
        return "";
      });
    });
  }, [toast]);

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

/**
 * Unlock probe for every Daily Work page — hits `GET /api/owner/session`.
 * Unlocks the UI immediately, then verifies the code; wrong codes lock again.
 */
export function useOwnerUnlock(options: {
  successTitle: string;
  successDescription?: string;
}) {
  const { toast } = useToast();
  const { unlock, lock } = useOwnerSession();

  return useMutation({
    mutationFn: async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) throw new Error("Enter your owner access code.");
      // Instant UI: open the page while the cheap session probe runs.
      unlock(trimmed);
      await apiRequest("GET", "/api/owner/session", undefined, {
        headers: { "x-paid-order-access-code": trimmed },
      });
      return trimmed;
    },
    onSuccess: () => {
      toast({
        title: options.successTitle,
        description: options.successDescription,
      });
    },
    onError: (error: Error) => {
      lock();
      toast({
        title: "That owner code was not accepted",
        description: describeOwnerAuthError(error),
        variant: "destructive",
      });
    },
  });
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
      className="rounded-lg border border-card-border bg-card/90 p-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)] md:items-end md:gap-6"
      aria-labelledby={`${testIdPrefix}-unlock-title`}
      data-testid={`panel-${testIdPrefix}-unlock`}
    >
      <div>
        <BrandMarkImage className="h-10 w-10" size={40} />
        <p className="mt-3 rule-label">Owner access</p>
        <h2 id={`${testIdPrefix}-unlock-title`} className="mt-1 text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          One unlock covers Floor, Queue, Labels, Orders, Prints, and the rest of Daily Work in this
          tab — until you Lock or reload.
        </p>
      </div>
      <form
        className="mt-5 space-y-3 md:mt-0"
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
            autoFocus
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
    </section>
  );
}
