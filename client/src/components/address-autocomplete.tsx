import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type AddressFill = {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

type Suggestion = AddressFill & {
  id: string;
  label: string;
};

export function AddressAutocomplete({
  street,
  onStreetChange,
  onSelect,
  id = "shipping-street",
}: {
  street: string;
  onStreetChange: (value: string) => void;
  onSelect: (value: AddressFill) => void;
  id?: string;
}) {
  const provider = useQuery({
    queryKey: ["/api/address-provider"],
    queryFn: async () => {
      const response = await fetch("/api/address-provider");
      if (!response.ok) return { enabled: false };
      const data = (await response.json()) as { provider?: { enabled?: boolean } };
      return { enabled: data.provider?.enabled === true };
    },
    staleTime: 60_000,
    retry: false,
  });
  const suggestionsOn = provider.data?.enabled === true;
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    const query = street.trim();
    if (!suggestionsOn || query.length < 3) {
      setSuggestions([]);
      setOpen(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/address-suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        if (!response.ok) throw new Error("suggest failed");
        const data = (await response.json()) as { ok: true; suggestions: Suggestion[] };
        if (cancelled) return;
        setSuggestions(data.suggestions ?? []);
        setOpen((data.suggestions ?? []).length > 0);
        setActiveIndex(-1);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [street, suggestionsOn]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const choose = (suggestion: Suggestion) => {
    onSelect({
      street: suggestion.street || suggestion.label,
      city: suggestion.city,
      state: suggestion.state,
      postalCode: suggestion.postalCode,
      country: suggestion.country,
    });
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div ref={rootRef} className="relative space-y-1.5">
      <Label htmlFor={id}>
        Street
        <span className="text-primary"> *</span>
      </Label>
      <div className="relative">
        <Input
          id={id}
          name="address-line1"
          type="text"
          autoComplete="address-line1"
          autoCapitalize="words"
          value={street}
          onChange={(event) => onStreetChange(event.target.value)}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
          onKeyDown={(event) => {
            if (!open || suggestions.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % suggestions.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
            } else if (event.key === "Enter" && activeIndex >= 0) {
              event.preventDefault();
              choose(suggestions[activeIndex]!);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          data-testid="input-shipping-street"
        />
        {suggestionsOn ? (
          <MapPin className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        ) : null}
      </div>
      {suggestionsOn ? (
        <p className="text-xs text-muted-foreground">
          Start typing and pick a suggestion to fill city, state, and ZIP.
          {loading ? " Looking up addresses…" : ""}
        </p>
      ) : null}

      {open && suggestions.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
          data-testid="list-address-suggestions"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  index === activeIndex ? "bg-primary/10 text-foreground" : "hover:bg-muted/70",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(suggestion)}
                data-testid={`button-address-suggestion-${index}`}
              >
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{suggestion.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
